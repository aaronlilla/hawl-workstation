// Route table: each user-plane call hits the method, path, auth plane and body the relay's route
// files define (apps/relay/src, read 2026-10-19). Catches typos; the smoke tests prove the rest.
import { describe, expect, it } from 'vitest'
import { generateWorkerKey, HawlClient, type TokenSource } from './index'

type Seen = { method: string; path: string; query: string; auth: string; body: unknown }

function setup() {
  const seen: Seen[] = []
  const f = (async (url: string | URL, init: RequestInit = {}) => {
    const u = new URL(String(url))
    if (u.pathname === '/v1/auth/token') {
      return new Response(JSON.stringify({ access_token: 'AGENT', expires_in: 600 }))
    }
    const h = new Headers(init.headers)
    let body: unknown
    if (typeof init.body === 'string') {
      body = JSON.parse(init.body)
    } else if (init.body) {
      body = { bytes: (init.body as Uint8Array).length }
    }
    seen.push({
      method: init.method ?? 'GET',
      path: u.pathname,
      query: u.search,
      auth: h.get('authorization') ?? '',
      body
    })
    if (u.pathname.endsWith('/files/uploads')) {
      return new Response(
        JSON.stringify({
          upl_id: 'upl_1',
          put_url: `${u.origin}${u.pathname}/upl_1`,
          expires_in: 300
        })
      )
    }
    return new Response('{}')
  }) as typeof fetch
  const user: TokenSource = { token: async () => 'USER', invalidate() {} }
  const k = generateWorkerKey()
  const c = new HawlClient({
    credentials: {
      relayUrl: 'https://relay.test',
      residentId: 'res_1',
      kid: 'key_1',
      townId: 'twn_1',
      townSlug: 's',
      privateJwk: k.privateJwk
    },
    user,
    fetch: f
  })
  return { c, seen }
}

const U = 'Bearer USER'
const A = 'Bearer AGENT'

describe('route table', () => {
  const T = 'twn_1'
  const cases: [string, (c: HawlClient) => Promise<unknown>, Partial<Seen>][] = [
    ['mySites', (c) => c.mySites(), { method: 'GET', path: '/v1/me/sites', auth: U }],
    ['myYards', (c) => c.myYards(), { method: 'GET', path: '/v1/me/villages', auth: U }],
    [
      'approvals.list',
      (c) => c.approvals.list(T),
      { path: `/v1/towns/${T}/approvals`, query: '?state=pending', auth: U }
    ],
    [
      'approvals.approve',
      (c) => c.approvals.approve('apr_1', 'ok'),
      { method: 'POST', path: '/v1/approvals/apr_1/approve', auth: U, body: { note: 'ok' } }
    ],
    [
      'approvals.deny',
      (c) => c.approvals.deny('apr_1'),
      { method: 'POST', path: '/v1/approvals/apr_1/deny', auth: U, body: {} }
    ],
    [
      'asks.askOwner',
      (c) => c.asks.askOwner(T, 'stuck', 'hnd_1'),
      {
        method: 'POST',
        path: `/v1/towns/${T}/asks`,
        auth: U,
        body: { source: 'stuck', handoff_id: 'hnd_1' }
      }
    ],
    [
      'needs.list',
      (c) => c.needs.list(T, 'later'),
      { path: `/v1/towns/${T}/needs-action`, query: '?tab=later', auth: U }
    ],
    [
      'needs.done',
      (c) => c.needs.done(T, 'ni_1'),
      {
        method: 'POST',
        path: `/v1/towns/${T}/needs-action/done`,
        auth: U,
        body: { item_id: 'ni_1' }
      }
    ],
    [
      'needs.snooze',
      (c) => c.needs.snooze(T, 'ni_1', 'tomorrow', 60),
      {
        method: 'POST',
        path: `/v1/towns/${T}/needs-action/snooze`,
        auth: U,
        body: { item_id: 'ni_1', preset: 'tomorrow', utc_offset_min: 60 }
      }
    ],
    [
      'site.needsUndo',
      (c) => c.site.needsUndo(T, 'ni_1'),
      {
        method: 'POST',
        path: `/v1/towns/${T}/needs-action/undo`,
        auth: U,
        body: { item_id: 'ni_1' }
      }
    ],
    ['board.list', (c) => c.board.list(T), { path: `/v1/towns/${T}/board`, auth: U }],
    [
      'board.pinAsPerson',
      (c) => c.board.pinAsPerson(T, 'msg_1', 't'),
      {
        method: 'POST',
        path: `/v1/towns/${T}/board`,
        auth: U,
        body: { message_id: 'msg_1', title: 't' }
      }
    ],
    [
      'board.unpin',
      (c) => c.board.unpin(T, 'pin-uuid'),
      { method: 'DELETE', path: `/v1/towns/${T}/board/pin-uuid`, auth: U }
    ],
    [
      'channels.post',
      (c) => c.channels.post(T, 'chn_1', 'hi', { replyTo: 'msg_0' }),
      {
        method: 'POST',
        path: `/v1/towns/${T}/channels/chn_1/messages`,
        auth: U,
        body: { text: 'hi', reply_to: 'msg_0' }
      }
    ],
    [
      'handoffs.send',
      (c) => c.handoffs.send(T, { to: 'auto', spec: 'do it' }),
      { method: 'POST', path: `/v1/towns/${T}/handoffs`, auth: U, body: { to: 'auto', spec: 'do it' } }
    ],
    [
      'handoffs.byPerson',
      (c) => c.handoffs.byPerson('hnd_1', 'cancel', { reason: 'r' }),
      { method: 'POST', path: '/v1/handoffs/hnd_1/cancel', auth: U, body: { reason: 'r' } }
    ],
    [
      'handoffs.get (agent)',
      (c) => c.handoffs.get('hnd_1'),
      { path: '/v1/handoffs/hnd_1', auth: A }
    ],
    [
      'workers.inboxOf',
      (c) => c.workers.inboxOf(T, 'res_2'),
      { path: `/v1/towns/${T}/agents/res_2/inbox`, auth: U }
    ],
    [
      'site.workers.list',
      (c) => c.site.workers.list(T),
      { path: `/v1/towns/${T}/workers`, auth: U }
    ],
    [
      'site.workers.pause',
      (c) => c.site.workers.pause(T, 'res_2'),
      { method: 'POST', path: `/v1/towns/${T}/workers/res_2/pause`, auth: U }
    ],
    [
      'site.workers.resume',
      (c) => c.site.workers.resume(T, 'res_2'),
      { method: 'POST', path: `/v1/towns/${T}/workers/res_2/resume`, auth: U }
    ],
    [
      'site.workers.setTrustedSenders',
      (c) => c.site.workers.setTrustedSenders(T, 'res_2', ['res_3']),
      {
        method: 'PUT',
        path: `/v1/towns/${T}/workers/res_2/trusted-senders`,
        auth: U,
        body: { senders: ['res_3'] }
      }
    ],
    [
      'site.workers.setLabel',
      (c) => c.site.workers.setLabel(T, 'res_2', 'L'),
      { method: 'PUT', path: `/v1/towns/${T}/agents/res_2/label`, auth: U, body: { label: 'L' } }
    ],
    [
      'site.handoffHistory.list (agent: the relay has no person route for the list)',
      (c) => c.site.handoffHistory.list('hnd_1'),
      { path: '/v1/handoffs/hnd_1/history', auth: A }
    ],
    [
      'site.handoffHistory.entry (agent)',
      (c) => c.site.handoffHistory.entry('hnd_1', 3, 'agent'),
      { path: '/v1/handoffs/hnd_1/history/3', auth: A }
    ],
    [
      'site.limits.pause',
      (c) => c.site.limits.pause(T, 'hnd_1'),
      { path: `/v1/towns/${T}/handoffs/hnd_1/limit-pause`, auth: U }
    ],
    [
      'site.limits.resume',
      (c) => c.site.limits.resume(T, 'hnd_1'),
      { method: 'POST', path: `/v1/towns/${T}/handoffs/hnd_1/resume`, auth: U }
    ],
    [
      'site.switches.get',
      (c) => c.site.switches.get(T),
      { path: `/v1/towns/${T}/settings/switches`, auth: U }
    ],
    [
      'site.switches.set',
      (c) => c.site.switches.set(T, { wake_enabled: false }),
      {
        method: 'PUT',
        path: `/v1/towns/${T}/settings/switches`,
        auth: U,
        body: { wake_enabled: false }
      }
    ],
    [
      'site.switches.freeze',
      (c) => c.site.switches.freeze(T),
      { method: 'POST', path: `/v1/towns/${T}/freeze`, auth: U }
    ],
    [
      'site.switches.unfreeze',
      (c) => c.site.switches.unfreeze(T),
      { method: 'POST', path: `/v1/towns/${T}/unfreeze`, auth: U }
    ],
    [
      'site.meter',
      (c) => c.site.meter(T, '2026-10-19'),
      { path: `/v1/towns/${T}/meter`, query: '?week=2026-10-19', auth: U }
    ],
    [
      'site.joins.lookup',
      (c) => c.site.joins.lookup('ABCD-EFGH'),
      { method: 'POST', path: '/v1/join/lookup', auth: U, body: { user_code: 'ABCD-EFGH' } }
    ],
    [
      'site.joins.approveDevice',
      (c) => c.site.joins.approveDevice('jrq_1', 'ABCD-EFGH', 'FP'),
      {
        method: 'POST',
        path: '/v1/join/jrq_1/approve-device',
        auth: U,
        body: { user_code: 'ABCD-EFGH', key_fingerprint: 'FP' }
      }
    ],
    [
      'site.joins.decide',
      (c) => c.site.joins.decide(T, 'jrq_1', 'deny'),
      { method: 'POST', path: `/v1/towns/${T}/joins/jrq_1/deny`, auth: U }
    ],
    [
      'site.files.delete',
      (c) => c.site.files.delete('fil_1'),
      { method: 'DELETE', path: '/v1/files/fil_1', auth: U }
    ],
    [
      'files.link',
      (c) => c.files.link('fil_1'),
      { method: 'POST', path: '/v1/files/fil_1/link', auth: U }
    ]
  ]

  for (const [name, call, want] of cases) {
    it(name, async () => {
      const { c, seen } = setup()
      await call(c)
      const got = seen.at(-1) as Seen
      for (const [k, v] of Object.entries(want)) {
        expect(got[k as keyof Seen], `${name}: ${k}`).toEqual(v)
      }
      if (!want.method) {
        expect(got.method).toBe('GET')
      }
    })
  }

  it('a person upload declares on the town route with the user token and a base64url hash, then PUTs with it', async () => {
    const { c, seen } = setup()
    await c.site.files.upload(T, 'a.txt', new TextEncoder().encode('hi'), 'text/plain', {
      as: 'res_9'
    })
    expect(seen).toHaveLength(2)
    expect(seen[0]).toMatchObject({ method: 'POST', path: `/v1/towns/${T}/files/uploads`, auth: U })
    const decl = seen[0]?.body as { sha256: string; as: string; bytes: number }
    expect(decl.sha256).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(decl).toMatchObject({ as: 'res_9', bytes: 2 })
    expect(seen[1]).toMatchObject({
      method: 'PUT',
      path: `/v1/towns/${T}/files/uploads/upl_1`,
      auth: U
    })
  })

  it('user-plane calls without a UserJWT source fail before touching the network', async () => {
    const { seen } = setup()
    const k = generateWorkerKey()
    const c = new HawlClient({
      credentials: {
        relayUrl: 'https://relay.test',
        residentId: 'res_1',
        kid: 'k',
        townId: 'twn_1',
        townSlug: 's',
        privateJwk: k.privateJwk
      },
      fetch: (async () => {
        throw new Error('network touched')
      }) as typeof fetch
    })
    await expect(c.approvals.list('twn_1')).rejects.toMatchObject({
      status: 401,
      code: 'unauthenticated'
    })
    expect(seen).toHaveLength(0)
  })
})
