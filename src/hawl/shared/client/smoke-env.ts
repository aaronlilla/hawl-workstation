// Shared setup for the smoke tests that run against the LOCAL stack (scripts/local-stack.mjs).
// Never production: the relay and web URLs must be loopback or the tests refuse to run.
//   relay  HAWL_SMOKE_LOCAL   default http://localhost:8080   ("off" skips the smokes)
//   web    HAWL_SMOKE_WEB     default http://localhost:3000
// Read-only SQL finds a local site owner (email) in the two local databases; sign-in itself goes
// through the real web app (emailed code read from the local e2e sink) and the real approve-device route.
import { it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import {
  Http,
  HawlClient,
  ManifestStore,
  PINNED_ROOTS,
  SiteApi,
  WebSession,
  startDeviceSignIn
} from './index'
import type { Credentials } from './index'

type RootSecrets = { rootKid?: string; rootPublicKey?: Record<string, string> }

/**
 * The root the LOCAL relay's key manifest is signed by. Every worktree's local stack writes its own throwaway
 * root to `<worktree>/_work/local-stack/secrets.json`, but they share one Postgres (`relay_local`), so whichever
 * stack ran `keys init` first owns the manifest. Read the public halves only, and pick the one that actually
 * verifies the manifest the relay serves now. Falls back to the e2e worktree's root, plus the pinned production root.
 */
export async function localRoots(): Promise<Record<string, Record<string, string>>> {
  const mine = `${platformDir}/_work/local-stack/secrets.json`
  const siblings = readdirSync(dirname(platformDir), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => `${dirname(platformDir)}/${d.name}/_work/local-stack/secrets.json`)
  const candidates = [mine, ...siblings.filter((p) => p !== mine)].flatMap((f) => {
    try {
      const s = JSON.parse(readFileSync(f, 'utf8')) as RootSecrets
      return s.rootKid && s.rootPublicKey ? [{ kid: s.rootKid, jwk: s.rootPublicKey }] : []
    } catch {
      return []
    }
  })
  let served: unknown = null
  try {
    served = await (await fetch(`${RELAY}/.well-known/relay-key-manifest.json`)).json()
  } catch {
    // no relay: the first candidate is as good as any
  }
  for (const c of candidates) {
    const store = new ManifestStore({ [c.kid]: c.jwk })
    if (served && (await store.accept(served)).ok) {
      return { ...PINNED_ROOTS, [c.kid]: c.jwk }
    }
  }
  const first = candidates[0]
  return { ...PINNED_ROOTS, ...(first ? { [first.kid]: first.jwk } : {}) }
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

/**
 * A local site with an active owner and a test address. Read-only. The relay lists at most 500 workers and 100
 * pending approvals per site with no cursor, and every smoke run adds workers, so among the sites the tests can
 * use (a second member and a peer agent exist) the one with the fewest of both is chosen: runs spread over the sites and the lists stay under their caps however often this is run.
 */
export function findOwner(): Promise<Owner> {
  // One site per test file: the load changes as the tests add workers, so asking again must not move to another site.
  ownerOnce ??= pickOwner()
  return ownerOnce
}
let ownerOnce: Promise<Owner> | null = null

async function pickOwner(): Promise<Owner> {
  const relay = await pg('relay_local')
  const accounts = await pg('accounts_local')
  try {
    const rows = (
      await relay.query(
        `SELECT s.slug, m.user_id FROM sites s JOIN members m ON m.town_id = s.id
          WHERE m.role = 'owner' AND m.status = 'active' AND s.status = 'active'
            AND (m.cooldown_until IS NULL OR m.cooldown_until < now() - interval '1 hour')
            AND EXISTS (SELECT 1 FROM members m2 WHERE m2.town_id = s.id AND m2.role = 'member' AND m2.status = 'active'
                          AND (m2.cooldown_until IS NULL OR m2.cooldown_until < now() - interval '1 hour'))
            AND EXISTS (SELECT 1 FROM workers p WHERE p.town_id = s.id AND p.kind = 'agent' AND p.status = 'active'
                          AND p.platform NOT IN ('system', 'hawl_workstation'))
          ORDER BY (SELECT count(*) FROM workers w WHERE w.town_id = s.id)
                 + 5 * (SELECT count(*) FROM approvals a WHERE a.town_id = s.id AND a.state = 'pending'), s.slug
          LIMIT 20`
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
      trust: { roots: await localRoots() }
    })
  }
}

/**
 * `it` for tests that upload files. The local relay caps uploads per hour for the whole site and every
 * run shares it, so hitting the cap is the machine's state, not a client defect: the test is reported as
 * skipped (visible in the run) unless HAWL_SMOKE_REQUIRE=1, where it fails.
 */
export const itUploads = (name: string, fn: () => Promise<void>, timeout?: number): void => {
  it(
    name,
    async (ctx) => {
      try {
        await fn()
      } catch (e) {
        if (
          /Hourly upload limit/i.test(String((e as Error)?.message)) &&
          process.env.HAWL_SMOKE_REQUIRE !== '1'
        ) {
          console.warn(
            `[hawl-client smoke] "${name}" skipped: the site's hourly upload cap is used up`
          )
          ctx.skip()
        }
        throw e
      }
    },
    timeout
  )
}
