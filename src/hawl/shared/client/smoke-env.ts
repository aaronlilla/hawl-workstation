// Shared setup for the smoke tests that run against the LOCAL stack (scripts/local-stack.mjs).
// Never production: the relay and web URLs must be loopback or the tests refuse to run.
//   relay  HAWL_SMOKE_LOCAL   default http://localhost:8080   ("off" skips the smokes)
//   web    HAWL_SMOKE_WEB     default http://localhost:3000
// Read-only SQL finds a local site owner (email) in the two local databases; sign-in itself goes
// through the real web app (emailed code read from the local e2e sink) and the real approve-device route.
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { Http, HawlClient, PINNED_ROOTS, SiteApi, WebSession, startDeviceSignIn } from './index'
import type { Credentials } from './index'

/** The local stack's throwaway ROOT public key (never the private half), plus the pinned production root. */
export function localRoots(): Record<string, Record<string, string>> {
  const file = `${platformDir}/_work/local-stack/secrets.json`
  const sec = JSON.parse(readFileSync(file, 'utf8')) as {
    rootKid: string
    rootPublicKey: Record<string, string>
  }
  return { ...PINNED_ROOTS, [sec.rootKid]: sec.rootPublicKey }
}

export const RELAY = process.env.HAWL_SMOKE_LOCAL ?? 'http://localhost:8080'
export const WEB = process.env.HAWL_SMOKE_WEB ?? 'http://localhost:3000'

function isLoopback(u: string): boolean {
  try {
    const h = new URL(u).hostname
    return h === 'localhost' || h === '127.0.0.1' || h === '[::1]'
  } catch {
    return false
  }
}

/** Up means it answered at all. A slow answer under load is still up; only a refused connection is down. */
async function reachable(u: string, path: string): Promise<boolean> {
  try {
    await fetch(u + path, { signal: AbortSignal.timeout(8000) })
    return true
  } catch {
    return false
  }
}

const platformDir = process.env.HAWL_PLATFORM_E2E ?? 'E:/hawl-platform/.claude/worktrees/e2e'
let pgModule: (new (c: Record<string, unknown>) => PgClient) | null = null
try {
  pgModule = createRequire(`${platformDir}/apps/relay/package.json`)('pg').Client
} catch {
  pgModule = null
}
type PgClient = {
  connect(): Promise<void>
  end(): Promise<void>
  query(sql: string, args?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>
}

/** Decided once at import: is there a loopback relay and web to talk to? */
export const stackUp: boolean =
  process.env.HAWL_SMOKE_LOCAL !== 'off' &&
  isLoopback(RELAY) &&
  isLoopback(WEB) &&
  pgModule !== null &&
  (await reachable(RELAY, '/healthz')) &&
  (await reachable(WEB, '/'))

export function until<T>(fn: () => T | undefined | false, ms = 8000): Promise<T> {
  const t0 = Date.now()
  return new Promise((resolve, reject) => {
    const tick = () => {
      const v = fn()
      if (v) {
        return resolve(v as T)
      }
      if (Date.now() - t0 > ms) {
        return reject(new Error('timed out'))
      }
      setTimeout(tick, 20)
    }
    tick()
  })
}

async function pg(database: string): Promise<PgClient> {
  if (!pgModule) {
    throw new Error('pg is not resolvable from HAWL_PLATFORM_E2E')
  }
  const c = new pgModule({
    host: 'localhost',
    port: Number(process.env.HAWL_SMOKE_PG_PORT ?? 5433),
    user: 'postgres',
    password: 'postgres',
    database
  })
  await c.connect()
  return c
}

export type Owner = { slug: string; userId: string; email: string }

/** A local site with an active owner, newest-slug first is not needed: any works. Read-only. */
export async function findOwner(): Promise<Owner> {
  const relay = await pg('relay_local')
  const accounts = await pg('accounts_local')
  try {
    const rows = (
      await relay.query(
        `SELECT s.slug, m.user_id FROM sites s JOIN members m ON m.town_id = s.id
          WHERE m.role = 'owner' AND m.status = 'active' AND s.status = 'active'
          ORDER BY s.slug LIMIT 20`
      )
    ).rows as { slug: string; user_id: string }[]
    for (const r of rows) {
      const u = (await accounts.query('SELECT email FROM "user" WHERE id = $1', [r.user_id]))
        .rows[0] as { email?: string } | undefined
      if (u?.email?.endsWith('@example.com')) {
        return { slug: r.slug, userId: r.user_id, email: u.email }
      }
    }
    throw new Error('no local owner with an @example.com test address')
  } finally {
    await relay.end()
    await accounts.end()
  }
}

/** An active non-owner member of the owner's site with a test address. Read-only lookup. */
export async function findMember(owner: Owner): Promise<Owner> {
  const relay = await pg('relay_local')
  const accounts = await pg('accounts_local')
  try {
    const rows = (
      await relay.query(
        `SELECT m.user_id FROM members m JOIN sites s ON s.id = m.town_id
          WHERE s.slug = $1 AND m.role = 'member' AND m.status = 'active' LIMIT 20`,
        [owner.slug]
      )
    ).rows as { user_id: string }[]
    for (const r of rows) {
      const u = (await accounts.query('SELECT email FROM "user" WHERE id = $1', [r.user_id]))
        .rows[0] as { email?: string } | undefined
      if (u?.email?.endsWith('@example.com')) {
        return { slug: owner.slug, userId: r.user_id, email: u.email }
      }
    }
    throw new Error(`no active member with a test address in ${owner.slug}`)
  } finally {
    await relay.end()
    await accounts.end()
  }
}

/** Real web sign-in: emailed code (read from the local sink) -> session cookie. */
export async function webSignIn(email: string): Promise<WebSession> {
  await WebSession.sendCode(email, { webOrigin: WEB })
  let otp = ''
  const t0 = Date.now()
  while (!otp && Date.now() - t0 < 10_000) {
    const r = await fetch(`${WEB}/api/e2e/otp?email=${encodeURIComponent(email)}`)
    if (r.ok) {
      otp = ((await r.json()) as { otp?: string }).otp ?? ''
    }
    if (!otp) {
      await new Promise((r2) => setTimeout(r2, 200))
    }
  }
  if (!otp) {
    throw new Error('the local web app has no e2e otp sink (E2E_OTP_SINK)')
  }
  return WebSession.verifyCode(email, otp, { webOrigin: WEB })
}

/** Device-code sign-in, approved through the relay's real approve-device route as the person. */
export async function workerSignIn(
  owner: Owner,
  session: WebSession,
  label: string
): Promise<{ cred: Credentials; client: HawlClient; joinId: string }> {
  const s = await startDeviceSignIn({
    site: owner.slug,
    relayUrl: RELAY,
    machineName: 'smoke',
    folderLabel: label,
    pollMs: 100
  })
  const site = new SiteApi(new Http({ baseUrl: RELAY, user: session }))
  const found = await site.joins.lookup(s.userCode)
  if (found.key_fingerprint !== s.fingerprint) {
    throw new Error('the page and the device disagree on the key fingerprint')
  }
  await site.joins.approveDevice(found.join_id, s.userCode, found.key_fingerprint)
  const cred = await s.wait()
  return {
    cred,
    joinId: found.join_id,
    client: new HawlClient({
      credentials: cred,
      user: session,
      webOrigin: WEB,
      trust: { roots: localRoots() }
    })
  }
}
