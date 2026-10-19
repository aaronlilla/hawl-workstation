// Test fixture: a throwaway root key, a relay signing key, a manifest, and signed envelopes.
// Built the way the relay builds them (spec 04), so the client's verifier is checked against real signatures.
import { createHash, generateKeyPairSync, type KeyObject, sign as nodeSign } from 'node:crypto'
import { b64url, type Jwk, jcs } from './core'
import { readySignInput, type KeyManifest } from './verify'

const sha = (b: Uint8Array | string): string => createHash('sha256').update(b).digest('base64url')

export type SenderKey = { kid: string; priv: KeyObject; jwk: Jwk }

export function makeSender(kid = 'key_sender1'): SenderKey {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const pub = publicKey.export({ format: 'jwk' }) as Jwk
  return { kid, priv: privateKey, jwk: { kty: 'OKP', crv: 'Ed25519', x: String(pub.x) } }
}

export class TrustFixture {
  readonly rootKid = 'root_test'
  readonly relayKid = 'rk_test'
  readonly root = generateKeyPairSync('ed25519')
  readonly relay = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  now = Date.now()
  seq = 1
  revoked: { kid: string; at: string; reason: string }[] = []
  /** Extra relay keys the manifest lists (rotation tests). */
  extraKeys: { kid: string; jwk: Jwk; status: string }[] = []

  get roots(): Record<string, Jwk> {
    const pub = this.root.publicKey.export({ format: 'jwk' }) as Jwk
    return { [this.rootKid]: { kty: 'OKP', crv: 'Ed25519', x: String(pub.x) } }
  }

  manifest(o: { seq?: number; notBefore?: number; notAfter?: number } = {}): KeyManifest {
    const pub = this.relay.publicKey.export({ format: 'jwk' }) as Jwk
    const payload: KeyManifest['payload'] = {
      v: 1,
      seq: o.seq ?? this.seq,
      not_before: new Date(o.notBefore ?? this.now - 3_600_000).toISOString(),
      not_after: new Date(o.notAfter ?? this.now + 86_400_000).toISOString(),
      keys: [
        { kid: this.relayKid, jwk: { kty: 'EC', crv: 'P-256', x: String(pub.x), y: String(pub.y) }, status: 'current' },
        ...this.extraKeys
      ],
      revoked: this.revoked
    }
    return {
      payload,
      sig: {
        alg: 'EdDSA',
        kid: this.rootKid,
        sig: b64url(nodeSign(null, Buffer.from(jcs(payload), 'utf8'), this.root.privateKey))
      }
    }
  }

  signReady(p: Parameters<typeof readySignInput>[0]): string {
    return b64url(
      nodeSign('sha256', readySignInput(p), { key: this.relay.privateKey, dsaEncoding: 'ieee-p1363' })
    )
  }

  /** A delivery as the relay would sign it. `tamper` runs after signing. */
  envelope(o: {
    seq: number
    recipient: string
    text?: string
    sender?: SenderKey | null
    kid?: string
    receivedAt?: string
    senderResident?: string
    /** Sign (as the relay) a hash that does not match the content. */
    badRequestHash?: boolean
    badViewHash?: boolean
  }): Record<string, unknown> {
    const text = o.text ?? `hello ${o.seq}`
    const sender = o.sender === undefined ? makeSender() : o.sender
    const cr = {
      v: 1,
      sender_resident_id: o.senderResident ?? 'res_other',
      kid: sender?.kid ?? 'key_none',
      idempotency_key: `idem-${o.seq}`,
      conversation_id: null,
      derived_from: [],
      to: { kind: 'worker', resident_id: o.recipient },
      intent: 'inform',
      requested_capabilities: [],
      content: { parts: [{ kind: 'text', text }] },
      created_at: new Date(this.now).toISOString()
    }
    const bytes = Buffer.from(jcs(cr), 'utf8')
    const view = { parts: [{ kind: 'text', text }] }
    const senderSig = sender
      ? {
          alg: 'EdDSA',
          kid: sender.kid,
          covers: 'client_request',
          sig: b64url(nodeSign(null, bytes, sender.priv))
        }
      : undefined
    const relay = {
      message_id: `msg_${o.seq}`,
      conversation_id: 'cnv_1',
      from: { resident_id: cr.sender_resident_id, handle: '@other' },
      origin: 'agent',
      effective_intent: 'inform',
      received_at: o.receivedAt ?? new Date(this.now).toISOString(),
      expires_at: new Date(this.now + 86_400_000).toISOString(),
      request_hash: o.badRequestHash ? sha('other') : sha(bytes),
      content_sha256: sha(jcs(cr.content)),
      view_sha256: o.badViewHash ? sha('other') : sha(jcs(view)),
      delivery: { recipient_resident_id: o.recipient, inbox_seq: o.seq, attempt: 1 }
    }
    const signable: Record<string, unknown> = { v: 1, view, relay }
    if (senderSig) {
      signable.sender_sig = senderSig
    }
    const { attempt: _a, ...delivery } = relay.delivery
    const sigInput = Buffer.from(jcs({ ...signable, relay: { ...relay, delivery } }), 'utf8')
    return {
      v: 1,
      client_request: b64url(bytes),
      ...(senderSig ? { sender_sig: senderSig } : {}),
      view,
      relay,
      relay_sig: {
        alg: 'ES256',
        kid: o.kid ?? this.relayKid,
        covers: 'jcs:v1:{v,sender_sig,view,relay-minus-delivery.attempt}',
        sig: b64url(nodeSign('sha256', sigInput, { key: this.relay.privateKey, dsaEncoding: 'ieee-p1363' }))
      }
    }
  }
}
