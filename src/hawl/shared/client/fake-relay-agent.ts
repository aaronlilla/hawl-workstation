// Fake relay: agent-plane routes (me, tools, messages, channels, handoffs, inbox, files).
import { createHash, verify as nodeVerify } from 'node:crypto'
import { jcs } from './core'
import type { Ctx } from './fake-relay-ctx'
import { seqOfEnv } from './fake-relay-ws'

export function agentRoutes(c: Ctx): void {
  const { r, req, res, url, path, m, body, raw, json, agent } = c
  // agent plane
  const w = agent()
  if (m === 'GET' && path === '/v1/me') {
    if (!w) {
      return r.err(res, 401, 'unauthenticated', 'Invalid credentials.')
    }
    return json(200, {
      resident_id: w.id,
      town_id: r.townId,
      town_slug: w.slug,
      handle: 'workstation',
      display_name: 'Test',
      platform: 'hawl_workstation',
      status: 'active',
      limits: { send_per_min: 30, max_body_bytes: 32768 },
      unread: r.inbox.length,
      needs_action: 0
    })
  }
  if (m === 'DELETE' && path === '/v1/residents/me') {
    return w
      ? json(200, { state: 'suspended' })
      : r.err(res, 401, 'unauthenticated', 'Invalid credentials.')
  }
  if (m === 'POST' && path === '/v1/tools/call') {
    if (!w) {
      return r.err(res, 401, 'unauthenticated', 'Invalid credentials.')
    }
    const b = body as {
      name: string
      args: Record<string, unknown>
      client_request?: Record<string, unknown>
      sender_sig?: { sig: string; kid: string }
    }
    if (b.client_request) {
      const bytes = Buffer.from(jcs(b.client_request), 'utf8')
      const sigOk =
        nodeVerify(null, bytes, w.pub, Buffer.from(b.sender_sig?.sig ?? '', 'base64url')) &&
        b.sender_sig?.kid === w.kid
      r.signedSends.push({ tool: b.name, args: b.args, cr: b.client_request, sigOk })
      if (!sigOk) {
        return r.err(res, 400, 'bad_signature', 'sender_sig does not verify.')
      }
      return json(200, { message_id: 'msg_1', state: 'queued', handoff_id: 'hnd_1' })
    }
    if (b.name === 'who') {
      return json(200, {
        workers: [
          { handle: 'sam', resident_id: 'res_SAM', status: 'idle' },
          { handle: 'kit', resident_id: 'res_KIT', status: 'busy' }
        ].filter((x) => !b.args.query || x.handle === b.args.query)
      })
    }
    if (b.name === 'handoff_list') {
      return json(200, { handoffs: [{ handoff_id: 'hnd_1', state: 'asked', title: 'Fix it' }] })
    }
    if (b.name === 'board_read') {
      return json(200, { pins: [] })
    }
    return json(200, {})
  }
  if (m === 'POST' && path === '/v1/messages') {
    if (!w) {
      return r.err(res, 401, 'unauthenticated', 'Invalid credentials.')
    }
    const b = body as {
      client_request: Record<string, unknown>
      sender_sig: { sig: string; kid: string }
    }
    if (
      !req.headers['idempotency-key'] ||
      req.headers['idempotency-key'] !== b.client_request.idempotency_key
    ) {
      return r.err(res, 400, 'invalid_request', 'Idempotency-Key required.')
    }
    const sigOk =
      nodeVerify(
        null,
        Buffer.from(jcs(b.client_request), 'utf8'),
        w.pub,
        Buffer.from(b.sender_sig.sig, 'base64url')
      ) && b.sender_sig.kid === w.kid
    r.signedSends.push({ tool: 'message', args: undefined, cr: b.client_request, sigOk })
    if (!sigOk) {
      return r.err(res, 400, 'bad_signature', 'sender_sig does not verify.')
    }
    return json(202, { message_id: 'msg_1', state: 'queued' })
  }
  if (m === 'GET' && path === '/v1/channels') {
    if (!w) {
      return r.err(res, 401, 'unauthenticated', 'Invalid credentials.')
    }
    return json(200, {
      items: [
        {
          channel_id: 'chn_SQ',
          kind: 'square',
          name: 'square',
          topic: null,
          member: true,
          wake_on: null
        },
        {
          channel_id: 'chn_R1',
          kind: 'room',
          name: 'build',
          topic: null,
          member: true,
          wake_on: null
        }
      ]
    })
  }
  if (m === 'GET' && path === '/v1/handoffs/hnd_1') {
    if (!w) {
      return r.err(res, 401, 'unauthenticated', 'Invalid credentials.')
    }
    return json(200, { handoff_id: 'hnd_1', state: 'accepted' })
  }
  if (m === 'POST' && path === '/v1/handoffs/hnd_1/act') {
    if (!w) {
      return r.err(res, 401, 'unauthenticated', 'Invalid credentials.')
    }
    return json(200, { handoff_id: 'hnd_1', state: 'done', echo: body })
  }
  if (m === 'GET' && path === '/v1/inbox') {
    if (!w) {
      return r.err(res, 401, 'unauthenticated', 'Invalid credentials.')
    }
    const after = Number(url.searchParams.get('after_seq') ?? 0)
    const items = r.inbox
      .filter((e) => seqOfEnv(e) > after)
      .map((e) => ({ inbox_seq: seqOfEnv(e), envelope: e }))
    return json(200, { items, unread: items.length, needs_action: 0 })
  }
  if (m === 'POST' && path === '/v1/files/uploads') {
    if (!w) {
      return r.err(res, 401, 'unauthenticated', 'Invalid credentials.')
    }
    const b = body as { name: string; mime: string; bytes: number; sha256: string }
    // The real relay takes the SHA-256 as 43 base64url characters (files/uploads.ts SHA_RE).
    if (!/^[A-Za-z0-9_-]{43}$/.test(b.sha256)) {
      return r.err(res, 400, 'invalid_request', 'Bad sha256.')
    }
    return json(200, {
      upl_id: 'upl_1',
      put_url: `${r.url}/v1/files/uploads/upl_1`,
      expires_in: 300,
      expect: b
    })
  }
  if (m === 'PUT' && path === '/v1/files/uploads/upl_1') {
    if (!w) {
      return r.err(res, 401, 'unauthenticated', 'Invalid credentials.')
    }
    r.files.set('upl_1', raw)
    return json(200, {
      file_id: 'fil_1',
      state: 'scanning',
      sha256: createHash('sha256').update(raw).digest('base64url')
    })
  }
  if (m === 'GET' && path === '/v1/files/fil_1/content') {
    if (!w) {
      return r.err(res, 401, 'unauthenticated', 'Invalid credentials.')
    }
    res.writeHead(200, { 'content-type': 'application/octet-stream' })
    return void res.end(r.files.get('upl_1') ?? Buffer.alloc(0))
  }
}
