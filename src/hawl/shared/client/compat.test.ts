// Cross-check against the real protocol code in hawl-platform (read only). Skipped when that
// checkout is not on this machine. Proves the bytes this client signs are the bytes the relay verifies.
import { existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { createPrivateKey, createPublicKey } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { generateWorkerKey, handshakeInput, jcs, signEd25519 } from './core'

const root = process.env.HAWL_PLATFORM_DIR ?? 'E:/hawl-platform'
const proto = `${root}/packages/protocol/src`
const have = existsSync(`${proto}/jcs.ts`) && existsSync(`${proto}/sign.ts`) && existsSync(`${proto}/envelope.ts`)

describe.skipIf(!have)('matches @hawl/protocol', () => {
  const load = async (f: string) => import(/* @vite-ignore */ pathToFileURL(`${proto}/${f}`).href)

  it('canonical JSON is byte-identical on varied values', async () => {
    const { jcs: real } = await load('jcs.ts')
    const samples: unknown[] = [
      { b: 1, a: 2 },
      { z: [3, { y: 'é', x: '\u2028"\\' }], a: null, m: true, n: -0.5, big: 12345678901 },
      { v: 1, to: { kind: 'channel', channel_id: 'chn_X', mentions: ['res_B', 'res_A'] }, parts: [{ kind: 'text', text: 'hi\n\t☃' }] },
      [],
      {},
      'plain',
      { 'ключ': 1, 'a b': 2, '10': 3, '9': 4 }
    ]
    for (const s of samples) expect(jcs(s)).toBe(real(s))
  })

  it('the WS handshake and ready inputs are the same bytes', async () => {
    const { handshakeSignInput } = await load('sign.ts')
    const p = { nonce: 'n', clientNonce: 'c', residentId: 'res_1', serverTime: '2026-10-19T00:00:00.000Z' }
    expect(handshakeInput(p).equals(handshakeSignInput(p))).toBe(true)
  })

  it('a client_request signed here verifies with the protocol verifier', async () => {
    const { signClientRequest, verifySenderSig } = await load('envelope.ts')
    const { importPublicJwk } = await load('sign.ts')
    const k = generateWorkerKey()
    const cr = {
      v: 1,
      sender_resident_id: 'res_A',
      kid: 'key_A',
      idempotency_key: 'k1',
      conversation_id: null,
      reply_to: null,
      derived_from: [],
      to: { kind: 'worker', resident_id: 'res_B' },
      intent: 'request_action',
      requested_capabilities: [],
      content: { parts: [{ kind: 'text', text: 'do it' }, { kind: 'data', data: { handoff: { title: 't', criteria: [{ id: 'c1', text: 'x', check: 'manual' }] } } }] },
      created_at: '2026-10-19T00:00:00.000Z'
    }
    // Reference: what the CLI would send.
    const ref = signClientRequest(cr, createPrivateKey({ key: k.privateJwk, format: 'jwk' }))
    // Ours: same bytes, same signature (Ed25519 is deterministic).
    const bytes = Buffer.from(jcs(cr), 'utf8')
    expect(bytes.equals(ref.bytes)).toBe(true)
    const sig = signEd25519(k.privateJwk, bytes).toString('base64url')
    expect(sig).toBe(ref.sender_sig.sig)
    expect(verifySenderSig(ref.client_request, { alg: 'EdDSA', kid: 'key_A', covers: 'client_request', sig }, importPublicJwk(k.publicJwk))).toBe(true)
    expect(createPublicKey({ key: k.publicJwk, format: 'jwk' }).asymmetricKeyType).toBe('ed25519')
  })
})
