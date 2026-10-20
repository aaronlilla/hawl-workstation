import { describe, expect, it } from 'vitest'
import { assertSecureRelayUrl, DEFAULT_RELAY_URL, HawlApiError, startDeviceSignIn } from './index'

describe('relay URL guard: exact loopback only', () => {
  it.each([
    'http://127.evil.com',
    'http://127.0.0.1.evil.com:80',
    'http://localhost.evil.com',
    'http://relay.hawl.ai',
    'http://128.0.0.1',
    'http://127.0.0.999',
    'ws://10.0.0.1'
  ])('refuses %s', (u) => {
    expect(() => assertSecureRelayUrl(u)).toThrowError(HawlApiError)
  })

  it.each([
    'http://localhost:8080',
    'http://127.0.0.1:8080',
    'http://127.1.2.3',
    'http://127.1',
    'http://[::1]:8080',
    'https://relay.hawl.ai',
    'wss://relay.hawl.ai'
  ])('allows %s', (u) => {
    expect(() => assertSecureRelayUrl(u)).not.toThrow()
  })
})

const jsonRes = (body: string, status = 200) => async () =>
  new Response(body, { status, headers: { 'content-type': 'application/json' } })

describe('sign-in start answers', () => {
  it.each([
    ['an HTML page', '<html>captive portal</html>'],
    ['a truncated body', '{"join_id":"jrq_1","user_c'],
    ['no join_id', '{"user_code":"AB","key_fingerprint":"x","expires_in":60}'],
    ['no user_code', '{"join_id":"j","key_fingerprint":"x","expires_in":60}'],
    ['no fingerprint', '{"join_id":"j","user_code":"AB","expires_in":60}'],
    ['a zero lifetime', '{"join_id":"j","user_code":"AB","key_fingerprint":"x","expires_in":0}'],
    ['null', 'null']
  ])('%s is bad_response, not a raw error', async (_n, body) => {
    await expect(
      startDeviceSignIn({ site: 's', relayUrl: 'http://localhost:1', fetch: jsonRes(body) as typeof fetch })
    ).rejects.toMatchObject({ code: 'bad_response' })
  })
})

describe('device page', () => {
  const ok = JSON.stringify({ join_id: 'j', user_code: 'AB-CD', key_fingerprint: 'fp', expires_in: 60 })
  const start = (relayUrl: string, devicePage?: string) =>
    startDeviceSignIn({ site: 's', relayUrl, ...(devicePage ? { devicePage } : {}), fetch: jsonRes(ok) as typeof fetch })

  it('is hawl.ai/device only for the production relay', async () => {
    expect((await start(DEFAULT_RELAY_URL)).verificationUri).toBe('https://hawl.ai/device')
    expect((await start(`${DEFAULT_RELAY_URL}/`)).verificationUri).toBe('https://hawl.ai/device')
  })
  it('is null for any other relay unless the page is given', async () => {
    expect((await start('http://localhost:8080')).verificationUri).toBeNull()
    expect((await start('https://relay.staging.example.com')).verificationUri).toBeNull()
    expect((await start('http://localhost:8080', 'http://localhost:3000/device')).verificationUri).toBe(
      'http://localhost:3000/device'
    )
  })
})

describe('cancelling a sign-in', () => {
  const ok = JSON.stringify({ join_id: 'j', user_code: 'AB-CD', key_fingerprint: 'fp', expires_in: 600 })

  it('aborts a claim that is in flight at once', async () => {
    let n = 0
    const f = ((url: string, init?: RequestInit) => {
      if (String(url).endsWith('/join/start')) {
        return Promise.resolve(new Response(ok, { status: 200 }))
      }
      n++
      return new Promise<Response>((_res, rej) =>
        init?.signal?.addEventListener('abort', () => rej(init.signal?.reason ?? new Error('aborted')))
      )
    }) as typeof fetch
    const s = await startDeviceSignIn({ site: 's', relayUrl: 'http://localhost:1', fetch: f, pollMs: 60_000 })
    const ac = new AbortController()
    const p = s.wait({ signal: ac.signal })
    await new Promise((r) => setTimeout(r, 30))
    const t0 = Date.now()
    ac.abort()
    await expect(p).rejects.toMatchObject({ code: 'cancelled' })
    expect(Date.now() - t0).toBeLessThan(500)
    expect(n).toBe(1)
  })

  it('aborts during the poll sleep without waiting for it', async () => {
    const f = ((url: string) =>
      Promise.resolve(
        String(url).endsWith('/join/start')
          ? new Response(ok, { status: 200 })
          : new Response('{}', { status: 202 })
      )) as typeof fetch
    const s = await startDeviceSignIn({ site: 's', relayUrl: 'http://localhost:1', fetch: f, pollMs: 60_000 })
    const ac = new AbortController()
    const p = s.wait({ signal: ac.signal })
    setTimeout(() => ac.abort(), 50)
    const t0 = Date.now()
    await expect(p).rejects.toMatchObject({ code: 'cancelled' })
    expect(Date.now() - t0).toBeLessThan(1000)
  })
})
