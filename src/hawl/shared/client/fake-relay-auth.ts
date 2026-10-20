// Fake relay: manifest, key lookup, join and token routes.
import { createHash, createPublicKey, randomUUID, verify as nodeVerify } from 'node:crypto'
import { jcs, type Jwk } from './core'
import type { Ctx } from './fake-relay-ctx'

export function authRoutes(c: Ctx): void {
  const { r, res, path, m, body, json, agent } = c

  if (m === 'GET' && path === '/.well-known/relay-key-manifest.json') {
    const mf = r.manifestOverride ?? r.trust?.manifest()
    return mf ? json(200, mf) : r.err(res, 404, 'not_found', 'No manifest.')
  }
  const keyM = /^\/v1\/keys\/(key_[A-Za-z0-9_-]+)$/.exec(path)
  if (m === 'GET' && keyM) {
    if (!agent()) {
      return r.err(res, 401, 'unauthenticated', 'Sign in.')
    }
    const k = r.senderKeys.get(keyM[1] as string)
    return k
      ? json(200, { kid: keyM[1], state: 'active', compromised_at: null, ...k })
      : r.err(res, 404, 'not_found', 'Not found.')
  }

  if (m === 'POST' && path === '/v1/join/start') {
    const b = body as { town_slug: string; public_jwk: Jwk; platform: string }
    if (
      b.public_jwk?.kty !== 'OKP' ||
      b.public_jwk.x?.length !== 43 ||
      !/^[a-z0-9_]{1,40}$/.test(b.platform)
    ) {
      return r.err(res, 400, 'invalid_request', 'Bad public_jwk.')
    }
    const id = `jrq_${randomUUID()}`
    const jwk = { kty: 'OKP', crv: 'Ed25519', x: b.public_jwk.x }
    r.joins.set(id, {
      id,
      pub: createPublicKey({ key: jwk, format: 'jwk' }),
      jwk,
      slug: b.town_slug,
      polls: 0,
      code: 'ABCD-EFGH'
    })
    return json(201, {
      join_id: id,
      user_code: 'ABCD-EFGH',
      key_fingerprint: 'fp-test',
      expires_in: 600
    })
  }
  const claim = /^\/v1\/join\/([^/]+)\/claim$/.exec(path)
  if (m === 'POST' && claim) {
    const j = r.joins.get(claim[1] as string)
    if (!j) {
      return r.err(res, 404, 'not_found', 'Not found.')
    }
    const c = body as { nonce: string; ts: number; sig: string }
    const ok = nodeVerify(
      null,
      Buffer.from(jcs({ join_id: j.id, nonce: c.nonce, ts: c.ts })),
      j.pub,
      Buffer.from(c.sig, 'base64url')
    )
    if (!ok) {
      return r.err(res, 404, 'not_found', 'Not found.')
    }
    if (++j.polls <= r.approveAfterPolls) {
      return json(202, { state: 'pending' })
    }
    const rid = `res_${randomUUID()}`
    const kid = `key_${createHash('sha256')
      .update(j.jwk.x as string)
      .digest('hex')
      .slice(0, 20)}`
    r.workers.set(rid, { id: rid, kid, pub: j.pub, jwk: j.jwk, slug: j.slug })
    return json(200, {
      resident_id: rid,
      kid,
      town_id: r.townId,
      relay_url: r.url,
      needs_owner_approval: false
    })
  }
  if (m === 'POST' && path === '/v1/auth/token') {
    const a = (body as { client_assertion?: string })?.client_assertion ?? ''
    const [h, p, s] = a.split('.')
    try {
      const head = JSON.parse(Buffer.from(h as string, 'base64url').toString())
      const claims = JSON.parse(Buffer.from(p as string, 'base64url').toString()) as Record<
        string,
        unknown
      >
      const w = [...r.workers.values()].find((x) => x.kid === head.kid)
      const now = Math.floor(Date.now() / 1000)
      const good =
        w &&
        head.alg === 'EdDSA' &&
        nodeVerify(null, Buffer.from(`${h}.${p}`), w.pub, Buffer.from(s as string, 'base64url')) &&
        claims.iss === w.id &&
        claims.sub === w.id &&
        claims.aud === r.url &&
        (claims.exp as number) - (claims.iat as number) <= 60 &&
        (claims.exp as number) > now &&
        !r.seenJti.has(String(claims.jti))
      if (!good || !w) {
        return r.err(res, 401, 'unauthenticated', 'Invalid credentials.')
      }
      r.seenJti.add(String(claims.jti))
      const tok = `agent-tok-${++r.tokenCount}`
      r.tokens.set(tok, { res: w.id, expMs: Date.now() + r.tokenTtlS * 1000 })
      return json(200, { access_token: tok, token_type: 'Bearer', expires_in: r.tokenTtlS })
    } catch {
      return r.err(res, 401, 'unauthenticated', 'Invalid credentials.')
    }
  }
}
