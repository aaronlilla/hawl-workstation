// Routes outside the core worker/site paths: invite links and joiners, reputation disputes,
// directory intros, the weekly value roll-up, data exports and the elevation veto.
// Read from apps/relay/src/invites/invites.ts, reputation/routes.ts, directory/intro.ts,
// value/rollup.ts, export/routes.ts and http/routes/members.ts, 2026-10-19.
// Answer bodies are the relay's own JSON; shapes not pinned down by a test are left as records.
import type { Http } from './http'

type Rec = Record<string, unknown>

export class MoreApi {
  readonly #http: Http

  constructor(http: Http) {
    this.#http = http
  }

  invites = {
    /** Public preview of an invite link (no sign-in needed). */
    preview: (token: string): Promise<Rec> =>
      this.#http.get(`/v1/invites/${encodeURIComponent(token)}`, { plane: 'none' }),
    /** Where the signed-in person stands on this link (user plane). */
    status: (token: string): Promise<Rec> =>
      this.#http.get(`/v1/invites/${encodeURIComponent(token)}/status`, { plane: 'user' }),
    /** Ask to join through the link (user plane). */
    join: (token: string, name?: string): Promise<Rec> =>
      this.#http.post(`/v1/invites/${encodeURIComponent(token)}/join`, name ? { name } : {}, {
        plane: 'user'
      }),
    /** The site's current link; 404 when there is none (owner or inviter). */
    link: (townId: string): Promise<{ token: string; expires_at: string }> =>
      this.#http.get(`/v1/towns/${townId}/invite-link`, { plane: 'user' }),
    /** Make the link if there is none; `rotate` replaces it. */
    ensureLink: (townId: string, rotate = false): Promise<Rec> =>
      this.#http.post(`/v1/towns/${townId}/invite-link`, rotate ? { rotate: true } : {}, {
        plane: 'user'
      }),
    /** Let a person who came through the link in, or turn them down. */
    decideJoiner: (
      townId: string,
      joinerId: string,
      decision: 'let-in' | 'decline'
    ): Promise<Rec> =>
      this.#http.post(
        `/v1/towns/${townId}/invite-joiners/${encodeURIComponent(joinerId)}/${decision}`,
        {},
        {
          plane: 'user'
        }
      )
  }

  /** Worker track record. Agent plane: the relay checks the caller is a worker of that site. */
  reputation = {
    get: (workerId: string): Promise<Rec> => this.#http.get(`/v1/reputation/${workerId}`),
    dispute: (eventId: string, note?: string): Promise<Rec> =>
      this.#http.post(`/v1/reputation/events/${eventId}/dispute`, note ? { note } : {}),
    resolve: (eventId: string, outcome: 'excluded' | 'upheld'): Promise<Rec> =>
      this.#http.post(`/v1/reputation/events/${eventId}/resolve`, { outcome })
  }

  intros = {
    get: (townId: string, introId: string): Promise<Rec> =>
      this.#http.get(`/v1/towns/${townId}/directory/intros/${introId}`, { plane: 'user' }),
    decide: (townId: string, introId: string, decision: 'accept' | 'decline'): Promise<Rec> =>
      this.#http.post(
        `/v1/towns/${townId}/directory/intros/${introId}/decide`,
        { decision },
        { plane: 'user' }
      )
  }

  /** Counts for one week (`YYYY-MM-DD`, the week's start). The web app turns them into minutes. */
  value = {
    week: (townId: string, week: string): Promise<Rec> =>
      this.#http.get(`/v1/towns/${townId}/value`, { plane: 'user', query: { week } })
  }

  exports = {
    /** Start an export of the site (owner). The relay answers 202 and builds it in the background. */
    site: (townId: string): Promise<Rec> =>
      this.#http.post(`/v1/towns/${townId}/exports`, {}, { plane: 'user' }),
    /** Start an export of the person's own account data. */
    account: (): Promise<Rec> => this.#http.post('/v1/account/exports', {}, { plane: 'user' }),
    /** State of one export; when ready it carries the signed download link. */
    get: (exportId: string): Promise<Rec> =>
      this.#http.get(`/v1/exports/${exportId}`, { plane: 'user' })
  }

  members = {
    /** Owner refuses a pending elevation for a member. */
    vetoElevation: (townId: string, userId: string): Promise<Rec> =>
      this.#http.post(
        `/v1/towns/${townId}/members/${encodeURIComponent(userId)}/elevation/veto`,
        {},
        { plane: 'user' }
      )
  }
}
