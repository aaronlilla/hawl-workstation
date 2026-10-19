// Failure-path tests: what the client does when the relay refuses, rate-limits, restarts or the
// token expires. Each one failed before the round-2 fixes (see git log).
import { createPublicKey, verify } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  aesGcmCipher,
  AgentSocket,
  cookieHeaderFromSetCookie,
  type Credentials,
  FileCredentialStore,
  HawlApiError,
  HawlClient,
  jcs,
  jwtExpiryMs,
  startDeviceSignIn,
  type TokenSource,
  WebSession
} from './index'
import { FakeRelay } from './fake-relay'

let relay: FakeRelay
let cred: Credentials
const stoppers: (() => void)[] = []

beforeEach(async () => {
  relay = await new FakeRelay().start()
  cred = await (
    await startDeviceSignIn({
      site: 'aarons-site',
      relayUrl: relay.url,
      sleep: async () => {},
      pollMs: 1
    })
  ).wait()
})
afterEach(async () => {
  for (const s of stoppers.splice(0)) {
    s()
  }
  await relay.stop()
})

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

function until<T>(fn: () => T | undefined | false, ms = 5000): Promise<T> {
  const t0 = Date.now()
  return new Promise((resolve, reject) => {
    const tick = () => {
      const v = fn()
      if (v) {
        return resolve(v as T)
      }
      if (Date.now() - t0 > ms) {
        return reject(new Error(`timed out waiting: ${fn.toString()}`))
      }
      setTimeout(tick, 10)
    }
    tick()
  })
}

const jwtWith = (expMs: number, n = 0): string =>
  `h.${Buffer.from(JSON.stringify({ exp: Math.floor(expMs / 1000), n })).toString('base64url')}.s`

describe('device sign-in under load', () => {
  it('a 429 or 408 while polling is retried, honouring Retry-After', async () => {
    relay.approveAfterPolls = 1
    relay.failNext(/\/claim$/, 429, 1, 7)
    relay.failNext(/\/claim$/, 408, 1)
    const sleeps: number[] = []
    const s = await startDeviceSignIn({
      site: 'aarons-site',
      relayUrl: relay.url,
      sleep: async (ms) => void sleeps.push(ms),
      pollMs: 10
    })
    const c = await s.wait()
    expect(c.residentId).toMatch(/^res_/)
    // First wait is the relay's 7 s, not our 10 ms.
    expect(sleeps[0]).toBe(7000)
    expect(sleeps[1]).toBe(10)
  })

  it('an expired or unknown code is still fatal', async () => {
    relay.failNext(/\/claim$/, 404, 1)
    const s = await startDeviceSignIn({
      site: 'aarons-site',
      relayUrl: relay.url,
      sleep: async () => {},
      pollMs: 1
    })
    await expect(s.wait()).rejects.toMatchObject({ code: 'code_expired' })
  })
})

describe('worker socket under failure', () => {
  const sock = (o: Partial<ConstructorParameters<typeof AgentSocket>[0]> = {}) => {
    const s = new AgentSocket({
      credentials: cred,
      reconnectMs: { min: 10, max: 400 },
      random: () => 0,
      ...o
    })
    stoppers.push(() => s.stop())
    return s
  }

  for (const code of [4429, 4503]) {
    it(`close ${code} backs off instead of retrying at the fast rate`, async () => {
      const s = sock()
      s.start()
      await until(() => s.state === 'connected')
      relay.dropAgents(code)
      await wait(150)
      expect(relay.handshakes).toBe(1) // fast backoff (10 ms) would have reconnected several times
      await until(() => relay.handshakes === 2, 2000)
    })
  }

  it('start() twice makes one connection; after replaced, start() takes the socket back', async () => {
    const s = sock()
    s.start()
    s.start()
    await until(() => s.state === 'connected')
    await wait(60)
    expect(relay.handshakes).toBe(1)
    relay.dropAgents(4409)
    await until(() => s.state === 'replaced')
    s.start()
    await until(() => relay.handshakes === 2 && s.state === 'connected')
  })

  it('start() after stop() connects again', async () => {
    const s = sock()
    s.start()
    await until(() => s.state === 'connected')
    s.stop()
    s.start()
    await until(() => relay.handshakes === 2 && s.state === 'connected')
  })

  it('verifyDelivery drops bad envelopes, keeps order, never emits a dropped one', async () => {
    const env = (seq: number) => ({ relay: { delivery: { inbox_seq: seq } } })
    const delays = new Map([
      [1, 40],
      [2, 5],
      [3, 0]
    ])
    const s = sock({
      verifyDelivery: async (e) => {
        const seq = (e.relay as { delivery: { inbox_seq: number } }).delivery.inbox_seq
        await wait(delays.get(seq) ?? 0)
        return seq === 2 ? 'relay_sig' : null
      }
    })
    const got: number[] = []
    const dropped: { reason: string }[] = []
    s.on('deliver', (e) =>
      got.push((e.relay as { delivery: { inbox_seq: number } }).delivery.inbox_seq)
    )
    s.on('dropped', (d) => dropped.push(d))
    s.start()
    await until(() => s.state === 'connected')
    relay.pushDeliver(env(1))
    relay.pushDeliver(env(2))
    relay.pushDeliver(env(3))
    await until(() => got.length === 2 && dropped.length === 1)
    expect(got).toEqual([1, 3])
    expect(dropped[0]?.reason).toBe('relay_sig')
  })

  it('a verifier that throws drops the delivery with a reason', async () => {
    const s = sock({
      verifyDelivery: () => {
        throw new Error('boom')
      }
    })
    const dropped: { reason: string }[] = []
    s.on('dropped', (d) => dropped.push(d))
    s.start()
    await until(() => s.state === 'connected')
    relay.pushDeliver({ relay: { delivery: { inbox_seq: 1 } } })
    await until(() => dropped.length === 1)
    expect(dropped[0]?.reason).toMatch(/verify_error: boom/)
  })
})

describe('site event socket under failure', () => {
  const mk = (u: TokenSource, o: Record<string, unknown> = {}) => {
    const c = new HawlClient({ credentials: cred, user: u, webOrigin: relay.webOrigin })
    const s = c.townEvents(relay.townId, { socketOnly: true, settleMs: 40, ...o })
    stoppers.push(() => s.stop())
    return s
  }
  const fixed: TokenSource = { token: async () => relay.userToken, invalidate() {} }

  it('a relay that refuses auth every time is retried with growing waits, not in a hot loop', async () => {
    relay.consoleRefuseAuth = true
    const s = mk(fixed, { reconnectMs: { min: 100, max: 2000 }, random: () => 0 })
    const states: string[] = []
    s.on('state', (x) => states.push(x))
    await s.start()
    await wait(1500)
    // waits 50, 100, 200, 400, 800 ms: at most 6 connections in 1.5 s (was ~30)
    expect(relay.consoleOrigins.length).toBeLessThanOrEqual(7)
    expect(relay.consoleOrigins.length).toBeGreaterThanOrEqual(3)
    expect(states).not.toContain('live')
  })

  it('goes live only after the relay keeps the socket, and a good socket resets the backoff', async () => {
    const s = mk(fixed, { reconnectMs: { min: 20, max: 4000 }, random: () => 0 })
    await s.start()
    expect(s.state).toBe('connecting')
    await until(() => s.state === 'live')
    for (let i = 0; i < 3; i++) {
      for (const w of relay.consoleConns) {
        w.close(1011, 'drop')
      }
      await until(() => s.state === 'connecting')
      // If the backoff kept doubling this would take 40, 80, 160 ms and more; it stays at min.
      await until(() => s.state === 'live', 800)
    }
  })

  it('a frame from the relay also counts as accepted', async () => {
    relay.events.push({ seq: 1, event: 'e1' })
    const s = mk(fixed, { settleMs: 60_000 })
    await s.start()
    await until(() => s.state === 'live')
  })

  it('refreshes auth on the open socket before the token expires, without reconnecting', async () => {
    let n = 0
    const u: TokenSource = {
      token: async () => jwtWith(Date.now() + 1500, ++n),
      invalidate() {}
    }
    relay.acceptJwt = (j) => j.startsWith('h.')
    const s = mk(u, { refreshBeforeMs: 1000 })
    await s.start()
    await until(() => s.state === 'live')
    await until(() => relay.consoleAuths.length >= 3, 3000)
    expect(relay.consoleOrigins.length).toBe(1)
    expect(new Set(relay.consoleAuths).size).toBe(relay.consoleAuths.length)
    expect(s.state).toBe('live')
  })

  it('start() twice does not open two sockets', async () => {
    const s = mk(fixed)
    await s.start()
    await s.start()
    await until(() => s.state === 'live')
    expect(relay.consoleOrigins.length).toBe(1)
  })
})

describe('web session (UserJWT)', () => {
  type Call = { url: string; init: RequestInit }
  function stub(handler: (c: Call) => Response): { fetch: typeof fetch; calls: Call[] } {
    const calls: Call[] = []
    return {
      calls,
      fetch: (async (url: string | URL, init: RequestInit = {}) => {
        const c = { url: String(url), init }
        calls.push(c)
        return handler(c)
      }) as typeof fetch
    }
  }
  const json = (b: unknown, init: ResponseInit = {}) =>
    new Response(JSON.stringify(b), { headers: { 'content-type': 'application/json' }, ...init })
  const hdr = (c: Call, k: string) => new Headers(c.init.headers).get(k)

  it('parses Set-Cookie into a Cookie header, dropping attributes and deleted cookies', () => {
    const c = cookieHeaderFromSetCookie(
      [
        'better-auth.session_token=abc.def; Max-Age=604800; Path=/; HttpOnly; SameSite=Lax',
        'other=1; Path=/',
        'gone=x; Max-Age=0'
      ],
      'gone=y; keep=2'
    )
    expect(c).toBe('keep=2; better-auth.session_token=abc.def; other=1')
  })

  it('signs in with an emailed code and keeps the cookie', async () => {
    const saved: string[] = []
    const f = stub((c) => {
      if (c.url.endsWith('/send-verification-otp')) {
        return json({ success: true })
      }
      const h = new Headers({ 'content-type': 'application/json' })
      h.append('set-cookie', 'better-auth.session_token=tok; Path=/; HttpOnly')
      h.append('set-cookie', 'better-auth.last_used_login_method=email-otp; Max-Age=60')
      return new Response('{}', { headers: h })
    })
    const o = {
      webOrigin: 'https://hawl.test',
      fetch: f.fetch,
      onCookie: (c: string) => saved.push(c)
    }
    await WebSession.sendCode('a@b.test', o)
    const s = await WebSession.verifyCode('a@b.test', '123456', o)
    expect(s.cookie).toContain('better-auth.session_token=tok')
    expect(saved).toEqual([s.cookie])
    expect(JSON.parse(f.calls[0]?.init.body as string)).toEqual({
      email: 'a@b.test',
      type: 'sign-in'
    })
    expect(hdr(f.calls[1] as Call, 'origin')).toBe('https://hawl.test')
  })

  it('a wrong code surfaces the site message', async () => {
    const f = stub(() => json({ code: 'INVALID_OTP', message: 'Invalid OTP' }, { status: 400 }))
    await expect(
      WebSession.verifyCode('a@b.test', '000000', {
        webOrigin: 'https://hawl.test',
        fetch: f.fetch
      })
    ).rejects.toMatchObject({ status: 400, code: 'INVALID_OTP', message: 'Invalid OTP' })
  })

  it('mints a UserJWT with the cookie and same-origin headers, caches it, renews before expiry', async () => {
    let now = 1_000_000
    let n = 0
    const f = stub(() => {
      n++
      return json({
        token: jwtWith(now + 900_000, n),
        expires_at: Math.floor((now + 900_000) / 1000)
      })
    })
    const s = WebSession.fromCookie('sid=1', {
      webOrigin: 'https://hawl.test',
      fetch: f.fetch,
      now: () => now
    })
    const a = await s.token()
    expect(await s.token()).toBe(a)
    expect(f.calls.length).toBe(1)
    expect(f.calls[0]?.url).toBe('https://hawl.test/api/relay-token')
    expect(hdr(f.calls[0] as Call, 'cookie')).toBe('sid=1')
    expect(hdr(f.calls[0] as Call, 'sec-fetch-site')).toBe('same-origin')
    now += 900_000 - 30_000 // inside the 60 s renew window
    expect(await s.token()).not.toBe(a)
    s.invalidate()
    await s.token()
    expect(f.calls.length).toBe(3)
  })

  it('concurrent callers share one mint', async () => {
    const f = stub(() => json({ token: jwtWith(Date.now() + 900_000), expires_at: 0 }))
    const s = WebSession.fromCookie('sid=1', { webOrigin: 'https://hawl.test', fetch: f.fetch })
    await Promise.all([s.token(), s.token(), s.token()])
    expect(f.calls.length).toBe(1)
  })

  it('a 401 from the site means the session ended and clears the stored cookie', async () => {
    const saved: string[] = []
    const f = stub(() => json({ error: { code: 'unauthenticated' } }, { status: 401 }))
    const s = WebSession.fromCookie('sid=1', {
      webOrigin: 'https://hawl.test',
      fetch: f.fetch,
      onCookie: (c) => saved.push(c)
    })
    await expect(s.token()).rejects.toMatchObject({ status: 401, code: 'session_expired' })
    expect(saved).toEqual([''])
    await expect(s.token()).rejects.toMatchObject({ code: 'signed_out' })
    expect(f.calls.length).toBe(1)
  })

  it('persists a rotated cookie', async () => {
    const saved: string[] = []
    const f = stub(() => {
      const h = new Headers({ 'content-type': 'application/json' })
      h.append('set-cookie', 'sid=2; Path=/')
      return new Response(JSON.stringify({ token: jwtWith(Date.now() + 900_000), expires_at: 0 }), {
        headers: h
      })
    })
    const s = WebSession.fromCookie('sid=1; theme=dark', {
      webOrigin: 'https://hawl.test',
      fetch: f.fetch,
      onCookie: (c) => saved.push(c)
    })
    await s.token()
    expect(s.cookie).toBe('sid=2; theme=dark')
    expect(saved).toEqual(['sid=2; theme=dark'])
  })

  it('jwtExpiryMs reads exp and survives junk', () => {
    expect(jwtExpiryMs(jwtWith(5_000_000))).toBe(5_000_000)
    expect(jwtExpiryMs('nonsense')).toBeNull()
  })

  it('the HTTP client uses it for the user plane and retries once on a relay 401', async () => {
    const t = new WebSession_Counting()
    const c = new HawlClient({ credentials: cred, user: t })
    relay.failNext(/\/v1\/me\/sites$/, 401, 1)
    await c.mySites().catch(() => {})
    expect(t.invalidated).toBe(1)
    expect(t.minted).toBe(2)
  })
})

class WebSession_Counting implements TokenSource {
  minted = 0
  invalidated = 0
  async token(): Promise<string> {
    this.minted++
    return 'user-jwt-1'
  }
  invalidate(): void {
    this.invalidated++
  }
}

describe('encrypted credential store', () => {
  let dir = ''
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'hawl-store-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })
  const key = Buffer.alloc(32, 7)

  it('round-trips credentials, never writes the private key in the clear', async () => {
    const path = join(dir, 'sub', 'cred.bin')
    const st = new FileCredentialStore(path, aesGcmCipher(key))
    expect(await st.load()).toBeNull()
    await st.save(cred)
    expect(await st.load()).toEqual(cred)
    const bytes = (await readFile(path)).toString('latin1')
    expect(bytes).not.toContain(cred.privateJwk.d as string)
    expect(bytes).not.toContain(cred.residentId)
    await st.clear()
    expect(await st.load()).toBeNull()
  })

  it('a wrong key, a damaged file or a non-credential file reads as signed out', async () => {
    const path = join(dir, 'cred.bin')
    await new FileCredentialStore(path, aesGcmCipher(key)).save(cred)
    expect(await new FileCredentialStore(path, aesGcmCipher(Buffer.alloc(32, 9))).load()).toBeNull()
    const raw = await readFile(path)
    raw[raw.length - 1] = (raw.at(-1) ?? 0) ^ 1
    await writeFile(path, raw)
    expect(await new FileCredentialStore(path, aesGcmCipher(key)).load()).toBeNull()
    await writeFile(path, 'garbage')
    expect(await new FileCredentialStore(path, aesGcmCipher(key)).load()).toBeNull()
  })

  it('a restored credential signs in again', async () => {
    const path = join(dir, 'cred.bin')
    await new FileCredentialStore(path, aesGcmCipher(key)).save(cred)
    const back = await new FileCredentialStore(path, aesGcmCipher(key)).load()
    const me = await new HawlClient({ credentials: back as Credentials }).me()
    expect(me.resident_id).toBe(cred.residentId)
  })
})

describe('reply (thread_reply)', () => {
  it('signs a reply in the stored conversation, to the sender of a received message', async () => {
    const posted: { path: string; body: Record<string, unknown> }[] = []
    const msg = {
      message_id: 'msg_1',
      conversation_id: 'cnv_9',
      from: 'res_PEER',
      to: cred.residentId,
      role: 'received'
    }
    const f = (async (url: string | URL, init: RequestInit = {}) => {
      const path = new URL(String(url)).pathname
      if (path === '/v1/auth/token') {
        return new Response(JSON.stringify({ access_token: 'a', expires_in: 600 }))
      }
      if (path === '/v1/messages/msg_1') {
        return new Response(JSON.stringify(msg))
      }
      posted.push({ path, body: JSON.parse(String(init.body)) })
      return new Response(JSON.stringify({ message_id: 'msg_2', state: 'queued' }))
    }) as typeof fetch
    const c = new HawlClient({ credentials: cred, fetch: f })
    await c.send.reply('msg_1', 'on it')
    const p = posted[0] as {
      path: string
      body: {
        name: string
        args: unknown
        client_request: Record<string, unknown>
        sender_sig: { sig: string }
      }
    }
    expect(p.path).toBe('/v1/tools/call')
    expect(p.body.name).toBe('thread_reply')
    expect(p.body.args).toEqual({ message_id: 'msg_1', text: 'on it' })
    const cr = p.body.client_request
    expect(cr).toMatchObject({
      intent: 'reply',
      reply_to: 'msg_1',
      conversation_id: 'cnv_9',
      to: { kind: 'worker', resident_id: 'res_PEER' }
    })
    const pub = createPublicKey({
      key: { kty: 'OKP', crv: 'Ed25519', x: cred.privateJwk.x as string },
      format: 'jwk'
    })
    expect(
      verify(null, Buffer.from(jcs(cr)), pub, Buffer.from(p.body.sender_sig.sig, 'base64url'))
    ).toBe(true)
  })

  it('refuses a channel message', async () => {
    const f = (async (url: string | URL) => {
      const path = new URL(String(url)).pathname
      if (path === '/v1/auth/token') {
        return new Response(JSON.stringify({ access_token: 'a', expires_in: 600 }))
      }
      return new Response(
        JSON.stringify({
          message_id: 'msg_1',
          conversation_id: 'cnv_9',
          from: 'res_P',
          to: 'chn_1',
          role: 'sent'
        })
      )
    }) as typeof fetch
    const c = new HawlClient({ credentials: cred, fetch: f })
    await expect(c.send.reply('msg_1', 'x')).rejects.toBeInstanceOf(HawlApiError)
  })
})
