// Round 5: deadlines on every network call, safe concurrent saves, https-only sign-in start,
// honest claim errors, the @hawl/client alias.
import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  aesGcmCipher,
  type Credentials,
  DeviceSignIn,
  EncryptedFile,
  generateWorkerKey,
  HawlClient,
  MoreApi,
  safeStorageCipher,
  startDeviceSignIn,
  WebSession
} from '@hawl/client'
import { randomBytes } from 'node:crypto'

const servers: Server[] = []
afterEach(async () => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections()
    await new Promise((r) => s.close(r))
  }
})

/** A server that takes the request and never answers (a half-open socket or a captive portal). */
async function blackhole(opts: { headersThenStall?: boolean } = {}): Promise<string> {
  const s = createServer((_req, res) => {
    if (opts.headersThenStall) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.write('{"x":')
    }
  })
  servers.push(s)
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r))
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`
}

function cred(relayUrl: string): Credentials {
  const k = generateWorkerKey()
  return {
    relayUrl,
    residentId: 'res_T',
    kid: 'key_T',
    townId: 'twn_T',
    townSlug: 't',
    privateJwk: k.privateJwk
  }
}

const noSleep = async () => {}

describe('deadlines', () => {
  it('a server that never answers fails with timeout, and the next call is not stuck behind it', async () => {
    const url = await blackhole()
    const c = new HawlClient({
      credentials: cred(url),
      timeoutMs: 300,
      maxRetries: 0,
      sleep: noSleep
    })
    const t0 = Date.now()
    await expect(c.me()).rejects.toMatchObject({ code: 'timeout' })
    expect(Date.now() - t0).toBeLessThan(3000)
    const t1 = Date.now()
    await expect(c.me()).rejects.toMatchObject({ code: 'timeout' })
    expect(Date.now() - t1).toBeLessThan(3000)
  })

  it('a body that stalls after the headers also times out (an API call)', async () => {
    // Token exchange answers fast on a second server; the API server sends headers and stalls.
    const api = await blackhole({ headersThenStall: true })
    const c = new HawlClient({
      credentials: cred(api),
      timeoutMs: 300,
      maxRetries: 0,
      sleep: noSleep
    })
    // The token exchange itself hits the same stalled server, so it is the first to time out.
    await expect(c.me()).rejects.toMatchObject({ code: 'timeout' })
  })

  it('Http times out a stalled response body once the token is in hand', async () => {
    let tokenCalls = 0
    const s = createServer((req, res) => {
      if (req.url === '/v1/auth/token') {
        tokenCalls++
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ access_token: 'tok', expires_in: 600 }))
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.write('{"x":')
    })
    servers.push(s)
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r))
    const url = `http://127.0.0.1:${(s.address() as AddressInfo).port}`
    const c = new HawlClient({
      credentials: cred(url),
      timeoutMs: 400,
      maxRetries: 0,
      sleep: noSleep
    })
    const t0 = Date.now()
    await expect(c.me()).rejects.toMatchObject({ code: 'timeout' })
    expect(Date.now() - t0).toBeLessThan(3000)
    expect(tokenCalls).toBe(1)
  })

  it('sign-in start and claim time out instead of hanging', async () => {
    const url = await blackhole()
    await expect(
      startDeviceSignIn({ site: 's', relayUrl: url, timeoutMs: 300 })
    ).rejects.toMatchObject({
      code: 'timeout'
    })
    const key = generateWorkerKey()
    const d = new DeviceSignIn({ site: 's', relayUrl: url, timeoutMs: 300 }, key, {
      join_id: 'jrq_1',
      user_code: 'ABCD-1234',
      key_fingerprint: 'fp',
      expires_in: 600
    })
    await expect(d.claim()).rejects.toMatchObject({ code: 'timeout' })
  })

  it('wait() reaches its own expiry even when every claim hangs', async () => {
    const url = await blackhole()
    let t = 1_000_000
    const d = new DeviceSignIn(
      {
        site: 's',
        relayUrl: url,
        timeoutMs: 150,
        pollMs: 1,
        now: () => t,
        sleep: async () => {
          t += 60_000
        }
      },
      generateWorkerKey(),
      { join_id: 'jrq_1', user_code: 'ABCD-1234', key_fingerprint: 'fp', expires_in: 100 }
    )
    await expect(d.wait()).rejects.toMatchObject({
      code: 'timeout',
      message: expect.stringContaining('Timed out waiting')
    })
  })

  it('web session code mail and token mint time out', async () => {
    const url = await blackhole()
    await expect(
      WebSession.sendCode('a@b.c', { webOrigin: url, timeoutMs: 300 })
    ).rejects.toMatchObject({
      code: 'timeout'
    })
    const s = WebSession.fromCookie('a=b', { webOrigin: url, timeoutMs: 300 })
    await expect(s.token()).rejects.toMatchObject({ code: 'timeout' })
  })

  it('a caller abort still wins and is not reported as a timeout', async () => {
    const url = await blackhole()
    const c = new HawlClient({
      credentials: cred(url),
      timeoutMs: 5000,
      maxRetries: 0,
      sleep: noSleep
    })
    const ac = new AbortController()
    setTimeout(() => ac.abort(), 100)
    const p = c.http.get('/v1/directory/residents', { plane: 'none', signal: ac.signal })
    await expect(p).rejects.toMatchObject({ name: 'AbortError' })
  })
})

describe('EncryptedFile', () => {
  it('parallel saves all succeed, the last call wins, and no temp file is left', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hawl-ef-'))
    try {
      const f = new EncryptedFile(join(dir, 'cred.bin'), aesGcmCipher(randomBytes(32)))
      const results = await Promise.allSettled(
        Array.from({ length: 25 }, (_, i) => f.save(`value-${i}`))
      )
      expect(results.every((r) => r.status === 'fulfilled')).toBe(true)
      expect(await f.load()).toBe('value-24')
      expect(await readdir(dir)).toEqual(['cred.bin'])
      // A second instance on the same path (two stores) also never collides on the temp name.
      const g = new EncryptedFile(join(dir, 'cred.bin'), aesGcmCipher(randomBytes(32)))
      const both = await Promise.allSettled([f.save('a'), g.save('b'), f.clear()])
      expect(both.filter((r) => r.status === 'rejected')).toHaveLength(0)
      expect((await readdir(dir)).filter((n) => n.endsWith('.tmp'))).toEqual([])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('clear after save ends empty; save after clear ends full', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hawl-ef-'))
    try {
      const f = new EncryptedFile(join(dir, 'c.bin'), aesGcmCipher(randomBytes(32)))
      await Promise.all([f.save('secret-x-123456'), f.clear()])
      expect(await f.load()).toBeNull()
      await Promise.all([f.clear(), f.save('secret-y-123456')])
      expect(await f.load()).toBe('secret-y-123456')
      expect((await readFile(join(dir, 'c.bin'))).toString('utf8')).not.toContain('secret-y')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('safeStorageCipher refuses when the OS cannot encrypt, and round-trips when it can', () => {
    const none = {
      isEncryptionAvailable: () => false,
      encryptString: () => Buffer.alloc(0),
      decryptString: () => ''
    }
    expect(() => safeStorageCipher(none)).toThrow(/keyring/)
    const ok = {
      isEncryptionAvailable: () => true,
      encryptString: (p: string) => Buffer.from(Buffer.from(p).toString('base64')),
      decryptString: (b: Buffer) => Buffer.from(b.toString(), 'base64').toString()
    }
    const c = safeStorageCipher(ok)
    expect(c.decrypt(c.encrypt('hello'))).toBe('hello')
  })
})

describe('sign-in guards and errors', () => {
  it('start over plain http to a non-local relay is refused before any request', async () => {
    let called = 0
    const f = (async () => {
      called++
      return new Response('{}')
    }) as typeof fetch
    await expect(
      startDeviceSignIn({ site: 's', relayUrl: 'http://203.0.113.1:9', fetch: f })
    ).rejects.toMatchObject({ code: 'insecure_relay_url' })
    expect(called).toBe(0)
    expect(
      () =>
        new DeviceSignIn(
          { site: 's', relayUrl: 'http://203.0.113.1:9', fetch: f },
          generateWorkerKey(),
          {
            join_id: 'j',
            user_code: 'c',
            key_fingerprint: 'f',
            expires_in: 10
          }
        )
    ).toThrow(/plain http/)
    expect(called).toBe(0)
  })

  it('web sessions refuse a non-local plain-http origin', () => {
    expect(() => WebSession.fromCookie('a=b', { webOrigin: 'http://203.0.113.1' })).toThrow(
      /plain http/
    )
  })

  const mk = (fetchImpl: typeof fetch, relayUrl = 'https://relay.test') =>
    new DeviceSignIn(
      { site: 's', relayUrl, fetch: fetchImpl, sleep: noSleep, pollMs: 1 },
      generateWorkerKey(),
      {
        join_id: 'jrq_1',
        user_code: 'ABCD-1234',
        key_fingerprint: 'fp',
        expires_in: 600
      }
    )

  it('404 reads as expired/refused/clock with an honest message', async () => {
    const d = mk((async () => new Response('', { status: 404 })) as typeof fetch)
    await expect(d.claim()).rejects.toMatchObject({ code: 'code_expired', status: 404 })
    await expect(d.claim()).rejects.toThrow(/refused/)
  })

  it("other 4xx keep the relay's own error code instead of calling it an expiry", async () => {
    const d = mk(
      (async () =>
        new Response(
          JSON.stringify({ error: { code: 'invalid_request', message: 'Bad nonce.' } }),
          {
            status: 400
          }
        )) as typeof fetch
    )
    await expect(d.claim()).rejects.toMatchObject({
      code: 'invalid_request',
      status: 400,
      message: 'Bad nonce.'
    })
  })

  it('an unreadable 200 is a hard bad_response and wait() does not keep polling', async () => {
    let n = 0
    const d = mk((async () => {
      n++
      return new Response('<html>portal</html>', { status: 200 })
    }) as typeof fetch)
    await expect(d.wait()).rejects.toMatchObject({ code: 'bad_response' })
    expect(n).toBe(1)
  })

  it('an incomplete 200 is bad_response', async () => {
    const d = mk((async () => new Response('{"resident_id":"r"}', { status: 200 })) as typeof fetch)
    await expect(d.claim()).rejects.toMatchObject({ code: 'bad_response' })
  })

  it('network errors in claim keep wait() polling until the code expires', async () => {
    let n = 0
    let t = 0
    const d = new DeviceSignIn(
      {
        site: 's',
        relayUrl: 'https://relay.test',
        fetch: (async () => {
          n++
          throw new TypeError('fetch failed')
        }) as typeof fetch,
        sleep: async () => {
          t += 100_000
        },
        now: () => t,
        pollMs: 1
      },
      generateWorkerKey(),
      { join_id: 'j', user_code: 'c', key_fingerprint: 'f', expires_in: 250 }
    )
    await expect(d.wait()).rejects.toMatchObject({ code: 'timeout' })
    expect(n).toBeGreaterThanOrEqual(3)
  })

  const claimBody = (relay_url?: string) =>
    JSON.stringify({
      resident_id: 'res_1',
      kid: 'key_1',
      town_id: 'twn_1',
      ...(relay_url ? { relay_url } : {})
    })

  it('a relay_url on another host is ignored; the same host is kept', async () => {
    const other = mk(
      (async () => new Response(claimBody('https://evil.example'), { status: 200 })) as typeof fetch
    )
    const r1 = await other.claim()
    expect(r1.state === 'claimed' && r1.credentials.relayUrl).toBe('https://relay.test')
    const plain = mk(
      (async () => new Response(claimBody('http://relay.test'), { status: 200 })) as typeof fetch
    )
    const r2 = await plain.claim()
    expect(r2.state === 'claimed' && r2.credentials.relayUrl).toBe('https://relay.test')
    const same = mk(
      (async () => new Response(claimBody('https://relay.test/'), { status: 200 })) as typeof fetch
    )
    const r3 = await same.claim()
    expect(r3.state === 'claimed' && r3.credentials.relayUrl).toBe('https://relay.test')
  })
})

describe('alias and extra routes', () => {
  it('imports resolve through @hawl/client and the extra routes hit the right paths', async () => {
    const seen: string[] = []
    const s = createServer((req, res) => {
      seen.push(`${req.method} ${req.url}`)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        req.url === '/v1/auth/token' ? JSON.stringify({ access_token: 't', expires_in: 600 }) : '{}'
      )
    })
    servers.push(s)
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r))
    const url = `http://127.0.0.1:${(s.address() as AddressInfo).port}`
    const user = { token: async () => 'u', invalidate() {} }
    const c = new HawlClient({ credentials: cred(url), user, maxRetries: 0 })
    expect(c.more).toBeInstanceOf(MoreApi)
    await c.more.invites.preview('tok en')
    await c.more.invites.ensureLink('twn_1', true)
    await c.more.invites.decideJoiner('twn_1', 'ijn_1', 'let-in')
    await c.more.reputation.dispute('11111111-1111-1111-1111-111111111111', 'wrong')
    await c.more.intros.decide('twn_1', 'int_1', 'accept')
    await c.more.value.week('twn_1', '2026-10-12')
    await c.more.exports.site('twn_1')
    await c.more.exports.get('exp_1')
    await c.more.members.vetoElevation('twn_1', 'usr_1')
    expect(seen.filter((x) => !x.includes('auth/token'))).toEqual([
      'GET /v1/invites/tok%20en',
      'POST /v1/towns/twn_1/invite-link',
      'POST /v1/towns/twn_1/invite-joiners/ijn_1/let-in',
      'POST /v1/reputation/events/11111111-1111-1111-1111-111111111111/dispute',
      'POST /v1/towns/twn_1/directory/intros/int_1/decide',
      'GET /v1/towns/twn_1/value?week=2026-10-12',
      'POST /v1/towns/twn_1/exports',
      'GET /v1/exports/exp_1',
      'POST /v1/towns/twn_1/members/usr_1/elevation/veto'
    ])
  })
})
