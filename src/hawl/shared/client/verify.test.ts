import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  AgentSocket,
  type Credentials,
  HawlClient,
  ManifestStore,
  type ManifestPersistence,
  startDeviceSignIn,
  verifyEnvelope
} from './index'
import { FakeRelay } from './fake-relay'
import { makeSender, TrustFixture, type SenderKey } from './trust-fixture'

type Loose = {
  view: { parts: { text: string }[] }
  relay: { from: { handle: string } }
  relay_sig: { sig: string }
}

let relay: FakeRelay
let cred: Credentials
let fx: TrustFixture
let sender: SenderKey
const stoppers: (() => void)[] = []

beforeEach(async () => {
  relay = await new FakeRelay().start()
  fx = new TrustFixture()
  relay.trust = fx
  sender = makeSender('key_sender1')
  relay.senderKeys.set(sender.kid, { public_jwk: sender.jwk })
  const s = await startDeviceSignIn({
    site: 'aarons-site',
    relayUrl: relay.url,
    sleep: async () => {},
    pollMs: 1
  })
  cred = await s.wait()
})
afterEach(async () => {
  for (const s of stoppers.splice(0)) {
    s()
  }
  await relay.stop()
})

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

const client = (roots = fx.roots, persist?: ManifestPersistence, minRefreshGapMs = 0) =>
  new HawlClient({
    credentials: cred,
    trust: { roots, minRefreshGapMs, ...(persist ? { persist } : {}) },
    fetch
  })

/** A trusting client socket plus the lists of what it delivered and dropped. */
function watch(c: HawlClient, o: Partial<ConstructorParameters<typeof AgentSocket>[0]> = {}) {
  const s = c.socket({ reconnectMs: { min: 10, max: 40 }, random: () => 0, ...o })
  stoppers.push(() => s.stop())
  const got: number[] = []
  const dropped: string[] = []
  const errors: string[] = []
  const seq = (e: Record<string, unknown>) =>
    (e.relay as { delivery: { inbox_seq: number } }).delivery.inbox_seq
  s.on('deliver', (e) => got.push(seq(e)))
  s.on('dropped', (d) => dropped.push(`${seq(d.envelope)}:${d.reason}`))
  s.on('error', (e) => errors.push((e as { code?: string }).code ?? e.message))
  return { s, got, dropped, errors }
}

describe('manifest store', () => {
  it('accepts a root-signed manifest and refuses forged, unknown-root, rolled-back and out-of-window ones', async () => {
    const st = new ManifestStore(fx.roots, { clock: () => fx.now })
    expect(st.usable).toBe(false)
    expect(await st.accept(fx.manifest({ seq: 5 }))).toEqual({ ok: true, seq: 5, changed: true })
    expect(st.usable).toBe(true)
    expect(await st.accept(fx.manifest({ seq: 5 }))).toEqual({ ok: true, seq: 5, changed: false })
    expect(await st.accept(fx.manifest({ seq: 4 }))).toEqual({ ok: false, reason: 'rollback' })
    fx.revoked = [{ kid: 'rk_x', at: new Date(fx.now).toISOString(), reason: 'x' }]
    expect(await st.accept(fx.manifest({ seq: 5 }))).toEqual({ ok: false, reason: 'rollback' })
    const forged = fx.manifest({ seq: 9 })
    forged.payload.keys[0]!.kid = 'rk_evil'
    expect(await st.accept(forged)).toEqual({ ok: false, reason: 'root_sig' })
    expect(await st.accept({ nope: 1 })).toEqual({ ok: false, reason: 'schema' })
    const other = new TrustFixture()
    const m2 = other.manifest({ seq: 9 })
    expect(await st.accept(m2)).toEqual({ ok: false, reason: 'root_sig' })
    const unknown = fx.manifest({ seq: 9 })
    unknown.sig.kid = 'root_nope'
    expect(await st.accept(unknown)).toEqual({ ok: false, reason: 'unknown_root' })
    fx.revoked = []
    expect(await st.accept(fx.manifest({ seq: 10, notBefore: fx.now + 60_000 }))).toEqual({
      ok: false,
      reason: 'not_yet_valid'
    })
    expect(await st.accept(fx.manifest({ seq: 10, notAfter: fx.now - 1 }))).toEqual({
      ok: false,
      reason: 'expired'
    })
  })

  it('is unusable after its window ends, and a revoked relay key is refused from the revoke time on', async () => {
    let now = fx.now
    const st = new ManifestStore(fx.roots, { clock: () => now })
    fx.revoked = [{ kid: 'rk_test', at: new Date(fx.now + 1000).toISOString(), reason: 'x' }]
    await st.accept(fx.manifest())
    expect(st.relayKey('rk_test', new Date(fx.now).toISOString())).not.toBeNull()
    expect(st.relayKey('rk_test', new Date(fx.now + 1000).toISOString())).toBeNull()
    expect(st.relayKey('rk_test', 'garbage')).toBeNull()
    expect(st.relayKey('rk_other', new Date(fx.now).toISOString())).toBeNull()
    now = fx.now + 2 * 86_400_000
    expect(st.usable).toBe(false)
    expect(st.relayKey('rk_test', new Date(fx.now).toISOString())).toBeNull()
  })

  it('keeps the accepted manifest through the persistence seam and re-verifies a planted file', async () => {
    let saved: unknown = null
    const persist: ManifestPersistence = {
      load: async () => saved,
      save: async (m) => void (saved = m)
    }
    const a = new ManifestStore(fx.roots, { clock: () => fx.now, persist })
    await a.accept(fx.manifest({ seq: 3 }))
    const b = new ManifestStore(fx.roots, { clock: () => fx.now, persist })
    await b.load()
    expect(b.seq).toBe(3)
    saved = new TrustFixture().manifest({ seq: 99 })
    const c = new ManifestStore(fx.roots, { clock: () => fx.now, persist })
    await c.load()
    expect(c.seq).toBe(-1)
  })
})

describe('verifyEnvelope', () => {
  async function ctx() {
    const manifests = new ManifestStore(fx.roots, { clock: () => fx.now })
    await manifests.accept(fx.manifest())
    return {
      manifests,
      residentId: cred.residentId,
      senderKey: async (kid: string) =>
        kid === sender.kid
          ? (await import('node:crypto')).createPublicKey({ key: sender.jwk, format: 'jwk' })
          : null
    }
  }
  const mk = (o: Partial<Parameters<TrustFixture['envelope']>[0]> = {}) =>
    fx.envelope({ seq: 1, recipient: cred.residentId, sender, ...o })

  it('accepts a good delivery, with and without a sender signature', async () => {
    const c = await ctx()
    expect(await verifyEnvelope(mk(), c)).toBeNull()
    expect(await verifyEnvelope(mk({ sender: null }), c)).toBeNull()
  })

  it('names the first check that fails', async () => {
    const c = await ctx()
    const tamper = (f: (e: Loose) => void) => {
      const e = mk() as Loose
      f(e)
      return e
    }
    expect(await verifyEnvelope('x', c)).toBe('schema')
    expect(await verifyEnvelope({ v: 1 }, c)).toBe('schema')
    // text changed in the view after the relay signed: relay_sig covers the view
    expect(
      await verifyEnvelope(
        tamper((e) => (e.view.parts[0].text = 'evil')),
        c
      )
    ).toBe('relay_sig')
    // relay block changed
    expect(
      await verifyEnvelope(
        tamper((e) => (e.relay.from.handle = '@boss')),
        c
      )
    ).toBe('relay_sig')
    expect(
      await verifyEnvelope(
        tamper((e) => (e.relay_sig.sig = `${e.relay_sig.sig.slice(2)}AA`)),
        c
      )
    ).toBe('relay_sig')
    // a relay key the manifest does not list
    expect(await verifyEnvelope(mk({ kid: 'rk_evil' }), c)).toBe('relay_key_unknown')
    // signed by the wrong relay key
    const rogue = new TrustFixture()
    expect(
      await verifyEnvelope(rogue.envelope({ seq: 1, recipient: cred.residentId, sender }), c)
    ).toBe('relay_sig')
    // sender key unknown or wrong
    expect(await verifyEnvelope(mk({ sender: makeSender('key_unknown') }), c)).toBe('sender_sig')
    expect(await verifyEnvelope(mk({ sender: makeSender('key_sender1') }), c)).toBe('sender_sig')
    // delivery for someone else
    expect(await verifyEnvelope(mk({ recipient: 'res_someoneelse' }), c)).toBe('recipient')
    // empty manifest
    const empty = new ManifestStore(fx.roots, { clock: () => fx.now })
    expect(await verifyEnvelope(mk(), { ...c, manifests: empty })).toBe('manifest_unusable')
  })

  it('catches a request_hash and a view hash that do not match, even when the relay signed them', async () => {
    const c = await ctx()
    expect(await verifyEnvelope(mk({ badRequestHash: true }), c)).toBe('request_hash')
    expect(await verifyEnvelope(mk({ badViewHash: true }), c)).toBe('view_sha256')
  })
})

describe('worker socket with verification on', () => {
  it('hands over good deliveries in order, fetching the manifest on first use', async () => {
    relay.inbox.push(fx.envelope({ seq: 1, recipient: cred.residentId, sender }))
    const { s, got, dropped } = watch(client())
    s.start()
    await until(() => got.length === 1)
    relay.pushDeliver(fx.envelope({ seq: 2, recipient: cred.residentId, sender }))
    relay.pushDeliver(fx.envelope({ seq: 3, recipient: cred.residentId, sender: null }))
    await until(() => got.length === 3)
    expect(got).toEqual([1, 2, 3])
    expect(dropped).toEqual([])
    expect(
      relay.requests.filter((r) => r.path === '/.well-known/relay-key-manifest.json').length
    ).toBe(1)
  })

  it('drops forged, wrong-recipient and unknown-signer deliveries, never delivers them, and still delivers the next good one', async () => {
    const { s, got, dropped } = watch(client())
    s.start()
    await until(() => s.state === 'connected')
    const forged = fx.envelope({ seq: 1, recipient: cred.residentId, sender }) as Loose
    forged.view.parts[0].text = 'wire money to me'
    relay.pushDeliver(forged)
    relay.pushDeliver(fx.envelope({ seq: 2, recipient: 'res_other_person', sender }))
    relay.pushDeliver(new TrustFixture().envelope({ seq: 3, recipient: cred.residentId, sender }))
    relay.pushDeliver(fx.envelope({ seq: 4, recipient: cred.residentId, sender }))
    await until(() => got.length === 1)
    expect(got).toEqual([4])
    expect(dropped).toEqual(['1:relay_sig', '2:recipient', '3:relay_sig'])
  })

  it('a compromised sender key drops deliveries received after the compromise, not before', async () => {
    relay.senderKeys.set(sender.kid, {
      public_jwk: sender.jwk,
      compromised_at: new Date(fx.now + 5000).toISOString()
    })
    const { s, got, dropped } = watch(client())
    s.start()
    await until(() => s.state === 'connected')
    relay.pushDeliver(
      fx.envelope({
        seq: 1,
        recipient: cred.residentId,
        sender,
        receivedAt: new Date(fx.now).toISOString()
      })
    )
    relay.pushDeliver(
      fx.envelope({
        seq: 2,
        recipient: cred.residentId,
        sender,
        receivedAt: new Date(fx.now + 6000).toISOString()
      })
    )
    await until(() => got.length + dropped.length === 2)
    expect(got).toEqual([1])
    expect(dropped).toEqual(['2:sender_sig'])
  })

  it('a relay key revoked before the message was received drops it', async () => {
    fx.revoked = [{ kid: 'rk_test', at: new Date(fx.now - 1000).toISOString(), reason: 'leak' }]
    const { s, got } = watch(client())
    s.start()
    // The ready frame is signed with the revoked key too, so the relay itself is refused.
    await until(() => relay.handshakes >= 1)
    await new Promise((r) => setTimeout(r, 100))
    expect(got).toEqual([])
    expect(s.state).not.toBe('connected')
  })

  it('refuses the connection when the ready frame is not signed by a manifest key', async () => {
    const real = relay.trust!
    // Relay claims rk_test but signs ready with a different key.
    const rogue = new TrustFixture()
    const orig = real.signReady.bind(real)
    real.signReady = (p) => rogue.signReady(p)
    const { s, got, errors } = watch(client())
    s.start()
    await until(() => errors.includes('relay_not_trusted'))
    expect(s.state).not.toBe('connected')
    expect(got).toEqual([])
    real.signReady = orig
  })

  it('an untrusted relay with no error listener is refused quietly, not thrown into the process', async () => {
    const real = relay.trust!
    const rogue = new TrustFixture()
    real.signReady = (p) => rogue.signReady(p)
    const seen: unknown[] = []
    const on = (e: unknown) => seen.push(e)
    process.on('unhandledRejection', on)
    process.on('uncaughtException', on)
    try {
      const s = client().socket({ reconnectMs: { min: 10, max: 40 }, random: () => 0 })
      stoppers.push(() => s.stop())
      s.start()
      await until(() => relay.handshakes >= 2)
      await new Promise((r) => setTimeout(r, 100))
      expect(s.state).not.toBe('connected')
      expect(seen).toEqual([])
    } finally {
      process.off('unhandledRejection', on)
      process.off('uncaughtException', on)
    }
  })

  it('a relay that serves a manifest signed by another root is never trusted', async () => {
    relay.manifestOverride = new TrustFixture().manifest()
    const { s, errors } = watch(client())
    s.start()
    await until(() => errors.includes('relay_not_trusted'))
    expect(s.state).not.toBe('connected')
  })

  it('deliveries sent right after ready wait for the ready check, and still arrive once, in order', async () => {
    relay.inbox.push(
      fx.envelope({ seq: 1, recipient: cred.residentId, sender }),
      fx.envelope({ seq: 2, recipient: cred.residentId, sender }),
      fx.envelope({ seq: 3, recipient: cred.residentId, sender })
    )
    const { s, got } = watch(client())
    s.start()
    await until(() => got.length === 3)
    expect(got).toEqual([1, 2, 3])
  })

  it('refuses to build a socket without verification unless told to', () => {
    expect(() => new AgentSocket({ credentials: cred })).toThrow(/verifyDelivery/)
    expect(() => new AgentSocket({ credentials: cred, insecureNoVerify: true })).not.toThrow()
  })

  it('rotation: a new manifest listing a new relay key is fetched when an unknown kid shows up', async () => {
    const { s, got } = watch(client())
    s.start()
    await until(() => s.state === 'connected')
    // Rotate: a second relay key joins the manifest at seq 2.
    const second = new TrustFixture()
    fx.extraKeys = [
      {
        kid: 'rk_second',
        jwk: second.relay.publicKey.export({ format: 'jwk' }) as Record<string, string> as Record<
          string,
          string
        >,
        status: 'next'
      }
    ]
    fx.seq = 2
    // Use the second key's private half to sign: copy it into a fixture with kid rk_second.
    const signer = new TrustFixture()
    Object.assign(signer, { relay: second.relay, now: fx.now })
    const e = signer.envelope({ seq: 1, recipient: cred.residentId, sender, kid: 'rk_second' })
    relay.pushDeliver(e)
    await until(() => got.length === 1)
    expect(got).toEqual([1])
    expect(
      relay.requests.filter((r) => r.path === '/.well-known/relay-key-manifest.json').length
    ).toBe(2)
  })
})

describe('refused workers', () => {
  it('a suspended worker (close 4403) ends in the refused state and stops retrying', async () => {
    const { s } = watch(client(), { insecureNoVerify: true })
    const reasons: string[] = []
    s.on('refused', (r) => reasons.push(`${r.code}:${r.reason}`))
    s.start()
    await until(() => s.state === 'connected')
    relay.dropAgents(4403)
    await until(() => s.state === 'refused')
    const n = relay.handshakes
    await new Promise((r) => setTimeout(r, 150))
    expect(relay.handshakes).toBe(n)
    expect(reasons).toEqual(['4403:suspended'])
    // start() takes it back
    s.start()
    await until(() => s.state === 'connected')
  })

  it('a client that is too old (4426) is refused too', async () => {
    const { s } = watch(client(), { insecureNoVerify: true })
    const reasons: string[] = []
    s.on('refused', (r) => reasons.push(r.reason))
    s.start()
    await until(() => s.state === 'connected')
    relay.dropAgents(4426)
    await until(() => s.state === 'refused')
    expect(reasons).toEqual(['client_too_old'])
  })

  it('repeated failed handshakes (4401) end in refused; one success resets the count', async () => {
    const { s } = watch(client(), { insecureNoVerify: true, authStrikes: 3 })
    const reasons: string[] = []
    s.on('refused', (r) => reasons.push(r.reason))
    // Revoked worker: the relay no longer knows it.
    const w = relay.workers.get(cred.residentId)!
    relay.workers.delete(cred.residentId)
    s.start()
    await until(() => s.state === 'refused')
    expect(reasons).toEqual(['auth_failed'])
    const n = relay.handshakes
    await new Promise((r) => setTimeout(r, 100))
    expect(relay.handshakes).toBe(n)
    relay.workers.set(cred.residentId, w)
    s.start()
    await until(() => s.state === 'connected')
  })

  it('rate limiting (4429) keeps retrying', async () => {
    const { s } = watch(client(), { insecureNoVerify: true })
    s.start()
    await until(() => s.state === 'connected')
    relay.dropAgents(4429)
    await until(() => relay.handshakes >= 2 && s.state === 'connected', 8000)
  })
})
