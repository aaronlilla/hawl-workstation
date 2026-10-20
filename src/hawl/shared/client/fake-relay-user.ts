// Fake relay: user-plane routes (sites, approvals, handoffs, town events) and the /v1 fallback.
import type { Ctx } from './fake-relay-ctx'
import type { FakeEvent } from './fake-relay'

export function userRoutes(c: Ctx): void {
  const { r, res, url, path, m, body, bearer, json, user } = c
  // user plane
  if (
    path.startsWith(`/v1/towns/${r.townId}/`) ||
    path.startsWith('/v1/approvals/') ||
    path === '/v1/me/sites'
  ) {
    if (!user()) {
      return r.err(res, 401, 'unauthenticated', 'Invalid credentials.')
    }
    if (m === 'GET' && path === '/v1/me/sites') {
      return json(200, { sites: [] })
    }
    if (m === 'GET' && path.endsWith('/approvals')) {
      return json(200, {
        items: Array.from({ length: r.approvalCount }, (_, i) => ({
          approval_id: `apr_${i + 1}`,
          state: url.searchParams.get('state')
        }))
      })
    }
    // Shapes from apps/relay/src/http/routes (channels.ts discuss, handoffs create, resume).
    if (m === 'GET' && /\/channels\/[^/]+\/threads\/[^/]+$/.test(path)) {
      return json(200, {
        root: { message_id: 'msg_1', text: 'hello' },
        replies: [{ message_id: 'msg_2' }]
      })
    }
    if (m === 'POST' && /\/handoffs\/[^/]+\/discuss$/.test(path)) {
      return json(200, {
        channel_id: 'chn_1',
        message_id: 'msg_1',
        handoff_id: 'hnd_1',
        created: true
      })
    }
    if (m === 'POST' && /\/handoffs\/[^/]+\/resume$/.test(path)) {
      return json(200, { resumed: true })
    }
    if (m === 'POST' && path === `/v1/towns/${r.townId}/handoffs`) {
      const b = body as { to: string }
      return json(200, {
        handoff_id: 'hnd_9',
        number: 9,
        state: 'asked',
        assignee: b.to === 'auto' ? 'res_picked' : b.to,
        routed: b.to === 'auto'
      })
    }
    if (m === 'POST' && path === '/v1/approvals/apr_1/approve') {
      return json(200, { state: 'approved', note: (body as { note?: string })?.note })
    }
    if (m === 'GET' && path.endsWith('/events')) {
      const after = Number(url.searchParams.get('after_seq') ?? 0)
      const page = r.events.filter((e) => e.seq > after).slice(0, r.eventPageSize)
      return json(200, {
        // Like the relay: personal and owner-only rows are filtered out AFTER the page is cut, and
        // next_after_seq still comes from the unfiltered page.
        events: page
          .filter((e) => e.hidden !== true)
          .map((e) => ({ ...e, town_id: r.townId, at: '2026-10-19T00:00:00Z' })),
        next_after_seq: page.length ? (page.at(-1) as FakeEvent).seq : after
      })
    }
  }
  if (path.startsWith('/v1/')) {
    return r.err(res, bearer ? 404 : 401, bearer ? 'not_found' : 'unauthenticated', 'Not found.')
  }
  json(404, {})
}
