// The foreman's link to the Dispatcher (the relay), as a ForemanTransport over any HTTP client.
//
// What is proven and what is not (read this before trusting a route):
//  - PROVEN: every body this sends is checked against the vendored gateway-contract schemas (heartbeat,
//    lifecycle, menu) and the m2 extension schemas, and the routes, methods and error handling are exercised
//    against a recording fake (relay-transport.test.ts).
//  - NOT PROVEN: any of it against a real relay. The m2 routes (`/v1/handoffs/:id/foreman`,
//    `/v1/yards/:vil/sites/:twn/menu`, `/v1/agent/yard/heartbeat`) are in m2-contract.md section 3 but not on
//    origin/main yet (apps/relay/src/foreman and yards do not exist there, checked 2026-10-19). The done and
//    progress events use the handoff routes that exist today (`/act`, `/renew`), which assume the relay lets
//    the yard's owner act as the assignee: a call for the m2 builders to confirm.
// All routes live in ROUTES below so they change in one place when the relay does.
import type { Heartbeat, LifecycleEvent, Menu } from '../../shared/gateway-contract/contract'
import { checkContract } from '../../shared/gateway-contract/contract'
import type { ExtendedMenu } from './menu'
import type {
  ForemanTransport,
  HandBack,
  OwnerNotice,
  RequesterNotice
} from './types'

/** The slice of an HTTP client this needs. @hawl/client's Http satisfies it (errors carry `status`). */
export type RelayHttpLike = {
  request(
    method: string,
    path: string,
    opts?: { body?: unknown; plane?: 'agent' | 'user' }
  ): Promise<unknown>
}

export type RelayTarget = {
  /** This yard (`vil_...`) and the site it is plugged into (`twn_...`). */
  yardId: string
  siteId: string
}

/** Where owner and requester notices go. The owner is at the workstation: the app shows them. */
export type NoticeSinks = {
  owner(n: OwnerNotice): void | Promise<void>
  /** No relay route carries a requester notice yet (S35), so without a sink it is dropped and listed as dead. */
  requester?(n: RequesterNotice): void | Promise<void>
}

export const ROUTES = {
  /** m2 3.4 last line. Agent token. */
  heartbeat: () => '/v1/agent/yard/heartbeat',
  /** m2 3.1: PUT writes the menu, POST publish makes a revision live. Owner (user) plane. */
  menu: (t: RelayTarget) => `/v1/yards/${t.yardId}/sites/${t.siteId}/menu`,
  menuPublish: (t: RelayTarget) => `/v1/yards/${t.yardId}/sites/${t.siteId}/menu/publish`,
  /** m2 3.4: the to-yard owner accepts, declines, holds or releases a job. */
  foreman: (taskId: string) => `/v1/handoffs/${taskId}/foreman`,
  /** Exist today (packages/cli handoff_update, renew). */
  act: (taskId: string) => `/v1/handoffs/${taskId}/act`,
  renew: (taskId: string) => `/v1/handoffs/${taskId}/renew`
}

/** An error the relay will answer the same way every time: do not retry it. */
class Permanent extends Error {
  readonly permanent = true
}

const permanent = (m: string): Permanent => new Permanent(m)

/** 4xx other than "slow down", "timed out", "sign in again" and "not allowed yet" are final. */
function classify(err: unknown, what: string): never {
  const status = (err as { status?: unknown } | null)?.status
  const msg = err instanceof Error ? err.message : String(err)
  if (typeof status === 'number' && status >= 400 && status < 500) {
    if (![401, 403, 408, 425, 429].includes(status)) {
      throw permanent(`${what}: relay refused (${status}) ${msg}`)
    }
  }
  throw err instanceof Error ? err : new Error(`${what}: ${msg}`)
}

function evidenceOf(ev: LifecycleEvent): Record<string, unknown> {
  const out: { sha?: string; pr_url?: string; ci_url?: string; files?: string[] } = {}
  if (ev.revision_sha) {
    out.sha = ev.revision_sha
  }
  for (const e of ev.evidence ?? []) {
    if (e.kind === 'pr') {
      out.pr_url ??= e.ref
    } else if (e.kind === 'ci') {
      out.ci_url ??= e.ref
    } else if (e.kind === 'artifact') {
      out.files = [...(out.files ?? []), e.ref]
    } else if (e.kind === 'sha') {
      out.sha ??= e.ref
    }
  }
  return out
}

export function createRelayTransport(
  http: RelayHttpLike,
  target: RelayTarget,
  sinks: NoticeSinks
): ForemanTransport {
  /** The revision the relay last told us the menu is at, for `if_revision`. */
  let menuRevision: number | undefined

  const call = async (
    what: string,
    method: string,
    path: string,
    body: unknown,
    plane: 'agent' | 'user'
  ): Promise<unknown> => {
    try {
      return await http.request(method, path, { body, plane })
    } catch (err) {
      return classify(err, what)
    }
  }

  return {
    async sendHeartbeat(hb: Heartbeat) {
      const bad = checkContract('heartbeat', hb)
      if (bad) {
        throw permanent(`heartbeat does not fit the contract: ${bad}`)
      }
      await call('heartbeat', 'POST', ROUTES.heartbeat(), hb, 'agent')
    },

    async sendMenu(menu: Menu, _revision: number, extended: ExtendedMenu) {
      const bad = checkContract('menu', menu)
      if (bad) {
        throw permanent(`menu does not fit the contract: ${bad}`)
      }
      let put: { revision?: number } | null
      try {
        put = (await http.request('PUT', ROUTES.menu(target), {
          body: { menu: extended, ...(menuRevision !== undefined ? { if_revision: menuRevision } : {}) },
          plane: 'user'
        })) as { revision?: number } | null
      } catch (err) {
        if ((err as { status?: unknown } | null)?.status === 409) {
          // Somebody else moved the menu. Learn where it is; the retry uses that revision.
          const now = (await http.request('GET', ROUTES.menu(target), { plane: 'user' })) as {
            draft_revision?: number
            revision?: number
          } | null
          menuRevision = now?.draft_revision ?? now?.revision
          throw new Error('menu changed on the relay; trying again with its revision')
        }
        return classify(err, 'menu')
      }
      const draft = put?.revision
      if (typeof draft !== 'number') {
        throw permanent('relay answered the menu without a revision')
      }
      menuRevision = draft
      await call('menu publish', 'POST', ROUTES.menuPublish(target), { draft_revision: draft }, 'user')
    },

    async sendLifecycle(ev: LifecycleEvent) {
      const bad = checkContract('lifecycle', ev)
      if (bad) {
        throw permanent(`event does not fit the contract: ${bad}`)
      }
      const id = ev.task_id
      switch (ev.event) {
        case 'accept':
          await call('accept', 'POST', ROUTES.foreman(id), { op: 'accept' }, 'user')
          return
        case 'decline':
          await call(
            'decline',
            'POST',
            ROUTES.foreman(id),
            { op: 'decline', ...(ev.reason ? { reason: ev.reason } : {}) },
            'user'
          )
          return
        case 'done':
          await call('done', 'POST', ROUTES.act(id), { op: 'done', evidence: evidenceOf(ev) }, 'agent')
          return
        case 'progress':
          await call('progress', 'POST', ROUTES.renew(id), {}, 'agent')
          return
        default:
          // direct_line_*: the m2 line routes are keyed by a line id (`dln_`) the gateway events do not carry.
          throw permanent(`no relay route for the ${ev.event} event yet`)
      }
    },

    async handBack(back: HandBack) {
      await call(
        back.op,
        'POST',
        ROUTES.foreman(back.taskId),
        { op: back.op, reason: back.reason },
        'user'
      )
    },

    async notifyOwner(n: OwnerNotice) {
      await sinks.owner(n)
    },

    async notifyRequester(n: RequesterNotice) {
      if (!sinks.requester) {
        throw permanent('no relay route for requester notices yet (m2 gap)')
      }
      await sinks.requester(n)
    }
  }
}
