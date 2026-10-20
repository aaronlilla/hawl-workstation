// Round 7: token exchange retries, and a sign-in that survives a restart.
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  aesGcmCipher,
  AgentTokenSource,
  fileSecretStores,
  HawlClient,
  startDeviceSignIn,
  WebSession,
  WorkstationAccount,
  type Credentials
} from './index'
import { FakeRelay } from './fake-relay'

let relay: FakeRelay
let dir: string
beforeEach(async () => {
  relay = await new FakeRelay().start()
  dir = await mkdtemp(join(tmpdir(), 'hawl-acct-'))
})
afterEach(async () => {
  await relay.stop()
  await rm(dir, { recursive: true, force: true })
})

const noSleep = async () => {}

async function signIn(): Promise<Credentials> {
  const s = await startDeviceSignIn({
    site: 'aarons-site',
    relayUrl: relay.url,
    sleep: noSleep,
    pollMs: 1
  })
  return s.wait()
}

const tokenCalls = () => relay.requests.filter((r) => r.path === '/v1/auth/token')

describe('token exchange rides out a blip', () => {
  it('retries a 503 and still answers', async () => {
    const c = new HawlClient({ credentials: await signIn(), sleep: noSleep })
    relay.failNext(/\/v1\/auth\/token$/, 503, 1)
    expect((await c.me()).town_slug).toBe('aarons-site')
    expect(tokenCalls().length).toBe(2)
  })

  it('a 429 waits as long as retry-after says', async () => {
    const sleeps: number[] = []
    const c = new HawlClient({
      credentials: await signIn(),
      sleep: async (ms) => void sleeps.push(ms)
    })
    relay.failNext(/\/v1\/auth\/token$/, 429, 1, 3)
    await c.me()
    expect(sleeps).toContain(3000)
  })

  it('signs a new assertion for every try (the relay refuses a reused one)', async () => {
    const src = new AgentTokenSource(await signIn(), { sleep: noSleep })
    relay.failNext(/\/v1\/auth\/token$/, 502, 2)
    expect(await src.token()).toMatch(/^agent-tok-/)
    const jtis = tokenCalls().map((r) => (r.body as { client_assertion: string }).client_assertion)
    expect(new Set(jtis).size).toBe(3)
  })

  it('gives up after the retries and says why', async () => {
    const c = new HawlClient({ credentials: await signIn(), sleep: noSleep, maxRetries: 1 })
    relay.failNext(/\/v1\/auth\/token$/, 503, 5)
    await expect(c.me()).rejects.toMatchObject({ status: 503 })
    expect(tokenCalls().length).toBe(2)
  })

  it('a refused credential is not retried', async () => {
    const creds = await signIn()
    const c = new HawlClient({ credentials: { ...creds, kid: 'key_nope' }, sleep: noSleep })
    await expect(c.me()).rejects.toMatchObject({ status: 401 })
    expect(tokenCalls().length).toBe(1)
  })

  it('the web token mint retries too, and a 401 does not', async () => {
    let n = 0
    const exp = Math.floor(Date.now() / 1000) + 900
    const fetch = (async () => {
      n++
      if (n === 1) {
        return new Response('{}', { status: 503, headers: { 'retry-after': '2' } })
      }
      return new Response(JSON.stringify({ token: 'tok', expires_at: exp }), {
        headers: { 'content-type': 'application/json' }
      })
    }) as typeof globalThis.fetch
    const slept: number[] = []
    const s = WebSession.fromCookie('sid=1', {
      webOrigin: 'https://hawl.test',
      fetch,
      sleep: async (ms) => void slept.push(ms)
    })
    expect(await s.token()).toBe('tok')
    expect(n).toBe(2)
    expect(slept).toEqual([2000])
  })
})

describe('a sign-in that survives a restart', () => {
  const key = randomBytes(32)
  const stores = () => fileSecretStores(dir, aesGcmCipher(key))
  const webFetch = (cookieSeen: string[]) =>
    (async (url: string | URL, init: RequestInit = {}) => {
      const u = String(url)
      if (u.startsWith(relay.url)) {
        return fetch(u, init)
      }
      cookieSeen.push(String((init.headers as Record<string, string> | undefined)?.cookie))
      return new Response(JSON.stringify({ token: relay.userToken, expires_at: 0 }), {
        headers: { 'content-type': 'application/json' }
      })
    }) as typeof globalThis.fetch

  it('signs in, stores both secrets encrypted, and a new run is signed in with no questions', async () => {
    const a = await WorkstationAccount.open({ stores: stores(), sleep: noSleep })
    expect(a.state).toEqual({ worker: false, person: false })
    expect(a.client).toBeNull()
    const changes: string[] = []
    a.onChange((s) => changes.push(JSON.stringify(s)))
    const shown: string[] = []
    const c = await a.signInWorker(
      { site: 'aarons-site', relayUrl: relay.url, pollMs: 1 },
      { onCode: (s) => void shown.push(s.userCode) }
    )
    expect(shown).toEqual(['ABCD-EFGH'])
    expect((await c.me()).handle).toBe('workstation')
    await a.useBrowserCookie('better-auth.session_token=abc')
    expect(a.state).toEqual({ worker: true, person: true })
    // On disk: encrypted, no key material in the clear.
    const raw = (await readFile(join(dir, 'credentials.enc'))).toString('latin1')
    expect(raw).not.toContain('privateJwk')
    expect(raw).not.toContain(c.credentials.residentId)
    expect((await readFile(join(dir, 'web-cookie.enc'))).toString('latin1')).not.toContain('abc')

    // "Restart": a new account object, same folder.
    const seen: string[] = []
    const b = await WorkstationAccount.open({
      stores: stores(),
      sleep: noSleep,
      fetch: webFetch(seen),
      webOrigin: 'https://hawl.test'
    })
    expect(b.state).toEqual({ worker: true, person: true })
    expect(b.client?.credentials.residentId).toBe(c.credentials.residentId)
    expect((await (b.client as HawlClient).me()).resident_id).toBe(c.credentials.residentId)
    // The stored cookie reaches the user plane through the same client.
    expect(await (b.client as HawlClient).mySites()).toEqual({ sites: [] })
    expect(seen).toEqual(['better-auth.session_token=abc'])
  })

  it('person sign-out keeps the worker; the client stays the same object and the user plane says signed out', async () => {
    const a = await WorkstationAccount.open({
      stores: stores(),
      sleep: noSleep,
      fetch: webFetch([])
    })
    const c = await a.signInWorker(
      { site: 'aarons-site', relayUrl: relay.url, pollMs: 1 },
      { onCode: () => {} }
    )
    await a.useBrowserCookie('sid=1')
    await a.signOutPerson()
    expect(a.state).toEqual({ worker: true, person: false })
    expect(a.client).toBe(c)
    await expect(c.mySites()).rejects.toMatchObject({ code: 'signed_out' })
    const b = await WorkstationAccount.open({ stores: stores(), sleep: noSleep })
    expect(b.state).toEqual({ worker: true, person: false })
  })

  it('sign out of everything erases both files, and leave tells the relay', async () => {
    const a = await WorkstationAccount.open({
      stores: stores(),
      sleep: noSleep,
      fetch: webFetch([])
    })
    await a.signInWorker(
      { site: 'aarons-site', relayUrl: relay.url, pollMs: 1 },
      { onCode: () => {} }
    )
    await a.useBrowserCookie('sid=1')
    expect(await a.signOutAll({ leave: true })).toEqual({ left: true })
    expect(relay.requests.some((r) => r.method === 'DELETE' && r.path === '/v1/residents/me')).toBe(
      true
    )
    expect(a.state).toEqual({ worker: false, person: false })
    const b = await WorkstationAccount.open({ stores: stores(), sleep: noSleep })
    expect(b.state).toEqual({ worker: false, person: false })
  })

  it('a disk that refuses the write does not lose a key the relay will not hand out twice', async () => {
    const real = stores()
    const problems: string[] = []
    const a = await WorkstationAccount.open({
      stores: {
        ...real,
        credentials: {
          load: () => real.credentials.load(),
          save: () => Promise.reject(new Error('disk full')),
          clear: () => real.credentials.clear()
        }
      },
      sleep: noSleep,
      onStorageError: (w) => void problems.push(w)
    })
    const c = await a.signInWorker(
      { site: 'aarons-site', relayUrl: relay.url, pollMs: 1 },
      { onCode: () => {} }
    )
    expect((await c.me()).handle).toBe('workstation')
    expect(problems).toEqual(['credentials'])
    expect(String(a.storageProblem)).toContain('disk full')
  })

  it('a cancelled sign-in stores nothing', async () => {
    relay.approveAfterPolls = 1000
    const a = await WorkstationAccount.open({ stores: stores(), sleep: noSleep })
    const ac = new AbortController()
    const p = a.signInWorker(
      { site: 'aarons-site', relayUrl: relay.url, pollMs: 1 },
      { onCode: () => ac.abort(), signal: ac.signal }
    )
    await expect(p).rejects.toMatchObject({ code: 'cancelled' })
    expect(a.state.worker).toBe(false)
    expect((await WorkstationAccount.open({ stores: stores() })).state.worker).toBe(false)
  })

  it('a stored sign-in for a plain-http remote relay is ignored, not trusted', async () => {
    const real = stores()
    await real.credentials.save({
      relayUrl: 'http://relay.example.com',
      residentId: 'res_1',
      kid: 'key_1',
      townId: 'twn_1',
      townSlug: 's',
      privateJwk: { kty: 'OKP', crv: 'Ed25519', x: 'x', d: 'd' }
    } as Credentials)
    const a = await WorkstationAccount.open({ stores: real })
    expect(a.state.worker).toBe(false)
    expect(a.loadProblem).toContain('https')
  })
})
