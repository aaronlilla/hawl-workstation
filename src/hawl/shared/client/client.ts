// HawlClient: typed calls to the relay. Two auth planes, as on the relay itself:
//   agent plane: this app's worker (AgentToken from the device-code key). /v1/me, tools, handoffs, files, channels, inbox.
//   user plane:  the person (UserJWT from a TokenSource you supply). Approvals, asks, board, needs-action, site events.
// Routes read from apps/relay/src/http/routes and the feature route files, 2026-10-19.
import {
  type Credentials,
  type FetchLike,
  HawlApiError,
  type Jwk,
  type Sleep,
  type TokenSource,
  trimUrl
} from './core'
import { AgentSocket, type AgentSocketOptions } from './agent-socket'
import { AgentTokenSource, Http } from './http'
import { Sender } from './send'
import { createDeliveryTrust, type DeliveryTrust, type ManifestPersistence, pinnedRoots } from './verify'
import { channelsApi } from './channels-api'
import { FilesApi } from './files-api'
import { MoreApi } from './more-api'
import { SiteApi } from './site-api'
import { ASK_SOURCES } from './types'
import type {
  ApprovalItem,
  AskSource,
  BoardPin,
  Handoff,
  HandoffCreate,
  HandoffEvidence,
  HandoffOp,
  HandoffRow,
  HandoffSend,
  HandoffSent,
  HandoffState,
  Me,
  NeedsList,
  SnoozePreset,
  SiteSummary,
  WhoWorker,
  WorkerRow
} from './types'

export type * from './types'
import { TownEventStream, type TownEventStreamOptions } from './town-events'

export type ClientOptions = {
  credentials: Credentials
  /** UserJWT source for the user plane. Without it those calls throw 401 before touching the network. */
  user?: TokenSource
  fetch?: FetchLike
  sleep?: Sleep
  maxRetries?: number
  /** Deadline for one HTTP call, ms. Default 20 s. */
  timeoutMs?: number
  /** Sent as the Origin of the console socket; must equal the relay's web origin. Default https://hawl.ai. */
  webOrigin?: string
  version?: string
  /**
   * Who the relay is trusted through. Default: the pinned production root, plus `HAWL_DEV_PINNED_ROOTS`
   * for a loopback or staging relay. `persist` keeps the accepted key manifest between runs.
   */
  trust?: { roots?: Record<string, Jwk>; persist?: ManifestPersistence; minRefreshGapMs?: number }
}

export class HawlClient {
  readonly credentials: Credentials
  readonly http: Http
  readonly #o: ClientOptions
  readonly #agent: AgentTokenSource

  constructor(o: ClientOptions) {
    this.#o = o
    this.credentials = o.credentials
    this.#agent = new AgentTokenSource(o.credentials, {
      ...(o.fetch ? { fetch: o.fetch } : {}),
      ...(o.timeoutMs !== undefined ? { timeoutMs: o.timeoutMs } : {})
    })
    this.http = new Http({
      baseUrl: o.credentials.relayUrl,
      agent: this.#agent,
      ...(o.user ? { user: o.user } : {}),
      ...(o.fetch ? { fetch: o.fetch } : {}),
      ...(o.sleep ? { sleep: o.sleep } : {}),
      ...(o.maxRetries !== undefined ? { maxRetries: o.maxRetries } : {}),
      ...(o.timeoutMs !== undefined ? { timeoutMs: o.timeoutMs } : {})
    })
    this.site = new SiteApi(this.http)
    this.more = new MoreApi(this.http)
    this.files = new FilesApi(this.http)
  }

  // ---- identity -------------------------------------------------------------------------------

  me(): Promise<Me> {
    return this.http.get('/v1/me')
  }
  /** Sites the person belongs to, with the Do now count (user plane). */
  mySites(): Promise<{ sites: SiteSummary[] }> {
    return this.http.get('/v1/me/sites', { plane: 'user' })
  }
  /** The person's yards and which site each is live in (user plane). */
  myYards(): Promise<{
    yards: { id: string; folder: string; label: string }[]
    sites: { id: string; slug: string; name: string }[]
    memberships: { yard_id: string; site_id: string; on: boolean }[]
  }> {
    return this.http.get('/v1/me/villages', { plane: 'user' })
  }
  setPresence(status: 'idle' | 'busy' | 'away'): Promise<{ ok: boolean }> {
    return this.http.post('/v1/me/presence', { status })
  }
  /** `hawl leave`: suspends this worker and revokes its keys. The token stops working. */
  leave(): Promise<{ state: string }> {
    return this.http.delete('/v1/residents/me')
  }

  // ---- tools ----------------------------------------------------------------------------------

  /** `POST /v1/tools/call`. Send-type tools also need `signed`; `send.*` below builds it. */
  tool<T = unknown>(
    name: string,
    args: Record<string, unknown> = {},
    signed?: { client_request: unknown; sender_sig: unknown }
  ): Promise<T> {
    return this.http.post('/v1/tools/call', { name, args, ...signed })
  }

  /**
   * Signed sends (handoff, dm, square, room). See send.ts.
   */
  readonly send = new Sender(this)

  /** Worker controls, person file upload, proof history, limit pauses, switches, meter (user plane). */
  readonly site: SiteApi
  /** Invite links, reputation disputes, directory intros, value roll-up, exports, elevation veto. */
  readonly more: MoreApi

  // ---- workers --------------------------------------------------------------------------------

  workers = {
    /** Active workers in this site. `q` matches handle or display name. */
    list: (q?: string): Promise<{ items: WorkerRow[] }> =>
      this.http.get('/v1/directory/residents', { query: { q, scope: 'town' } }),
    /** The `who` tool: status, what each is working on, owner and yard. */
    who: (query?: string): Promise<{ workers: WhoWorker[] }> =>
      this.tool('who', query ? { query } : {}),
    /** Agent's inbox as seen by a member (user plane). Metadata only. */
    inboxOf: (townId: string, resId: string): Promise<unknown> =>
      this.http.get(`/v1/towns/${townId}/agents/${resId}/inbox`, { plane: 'user' })
  }

  // ---- handoffs (hauls) -----------------------------------------------------------------------

  handoffs = {
    list: (o: { state?: HandoffState; mine?: boolean } = {}): Promise<{ handoffs: HandoffRow[] }> =>
      this.tool('handoff_list', o),
    get: (id: string): Promise<Handoff> => this.http.get(`/v1/handoffs/${id}`),
    /** Create a haul for a named worker. Signs the request (see `send.handoff`). */
    create: (h: HandoffCreate & { to: string }): Promise<Record<string, unknown>> =>
      this.send.handoff(h),
    act: (
      id: string,
      op: HandoffOp,
      o: { evidence?: HandoffEvidence; reason?: string; to?: string; toResident?: string } = {}
    ): Promise<Record<string, unknown>> =>
      this.http.post(`/v1/handoffs/${id}/act`, {
        op,
        ...(o.evidence ? { evidence: o.evidence } : {}),
        ...(o.reason ? { reason: o.reason } : {}),
        ...(o.to ? { to: o.to } : {}),
        ...(o.toResident ? { to_resident: o.toResident } : {})
      }),
    accept: (id: string) => this.handoffs.act(id, 'accept'),
    decline: (id: string, reason: string) => this.handoffs.act(id, 'decline', { reason }),
    done: (id: string, evidence: HandoffEvidence) => this.handoffs.act(id, 'done', { evidence }),
    renew: (id: string): Promise<Record<string, unknown>> =>
      this.http.post(`/v1/handoffs/${id}/renew`),
    receipt: (rcp: string): Promise<{ receipt: Record<string, unknown>; superseded: boolean }> =>
      this.http.get(`/v1/receipts/${rcp}`),
    /** A person sends a work order (user plane). `to` is a worker id (`res_...`) or "auto", never a handle. */
    send: async (townId: string, body: HandoffSend): Promise<HandoffSent> => {
      if (body.to !== 'auto' && !/^res_[A-Za-z0-9_-]+$/.test(String(body.to))) {
        throw new HawlApiError(400, 'invalid_request', 'to is a worker id (res_...) or "auto", not a handle.')
      }
      if (typeof body.spec !== 'string' || body.spec.trim() === '' || body.spec.length > 8000) {
        throw new HawlApiError(400, 'invalid_request', 'Describe the work in 1 to 8000 characters.')
      }
      return this.http.post(`/v1/towns/${townId}/handoffs`, body, { plane: 'user' })
    },
    /** A person acts on one (user plane). */
    byPerson: (
      id: string,
      action: 'accept' | 'decline' | 'reassign' | 'cancel' | 'snooze' | 'pass' | 'send-back',
      body: { reason?: string; to?: string; evidence?: HandoffEvidence } = {}
    ): Promise<Record<string, unknown>> =>
      this.http.post(`/v1/handoffs/${id}/${action}`, body, { plane: 'user' })
  }

  // ---- approvals and asks (user plane) --------------------------------------------------------

  approvals = {
    /**
     * The relay returns the 100 OLDEST rows in that state and has no cursor. `truncated` is true when
     * the page is full: newer approvals may exist that this call cannot see (needs a relay change).
     */
    list: async (
      townId: string,
      state: 'pending' | 'approved' | 'denied' | 'expired' = 'pending'
    ): Promise<{ items: ApprovalItem[]; truncated: boolean }> => {
      const r = await this.http.get<{ items: ApprovalItem[] }>(`/v1/towns/${townId}/approvals`, {
        plane: 'user',
        query: { state }
      })
      return { items: r.items, truncated: (r.items?.length ?? 0) >= 100 }
    },
    approve: (aprId: string, note?: string): Promise<Record<string, unknown>> =>
      this.http.post(`/v1/approvals/${aprId}/approve`, note ? { note } : {}, { plane: 'user' }),
    deny: (aprId: string, note?: string): Promise<Record<string, unknown>> =>
      this.http.post(`/v1/approvals/${aprId}/deny`, note ? { note } : {}, { plane: 'user' })
  }

  asks = {
    /** Ask the site owner. `new:false` means this person already asked in the last 24 h. */
    askOwner: async (
      townId: string,
      source: AskSource,
      handoffId?: string
    ): Promise<{ sent: boolean; new: boolean; owner_user_id: string; asked_at: string }> => {
      if (!(ASK_SOURCES as readonly string[]).includes(source)) {
        throw new HawlApiError(400, 'invalid_request', `Bad source. Use one of: ${ASK_SOURCES.join(', ')}.`)
      }
      return this.http.post(
        `/v1/towns/${townId}/asks`,
        { source, ...(handoffId ? { handoff_id: handoffId } : {}) },
        { plane: 'user' }
      )
    }
  }

  needs = {
    list: (townId: string, tab: 'needs' | 'later' | 'done' = 'needs'): Promise<NeedsList> =>
      this.http.get(`/v1/towns/${townId}/needs-action`, { plane: 'user', query: { tab } }),
    done: (townId: string, itemId: string): Promise<unknown> =>
      this.http.post(
        `/v1/towns/${townId}/needs-action/done`,
        { item_id: itemId },
        { plane: 'user' }
      ),
    snooze: (townId: string, itemId: string, preset: SnoozePreset, utcOffsetMin = 0): Promise<unknown> =>
      this.http.post(
        `/v1/towns/${townId}/needs-action/snooze`,
        { item_id: itemId, preset, utc_offset_min: utcOffsetMin },
        { plane: 'user' }
      )
  }

  // ---- channels (square and rooms) ------------------------------------------------------------

  channels = channelsApi(() => this.http)

  // ---- messages and inbox (agent plane) -------------------------------------------------------

  inbox = {
    list: (
      afterSeq = 0,
      limit = 50
    ): Promise<{
      items: { inbox_seq: number; envelope: Record<string, unknown> }[]
      unread: number
      needs_action: number
    }> => this.http.get('/v1/inbox', { query: { after_seq: afterSeq, limit } }),
    ack: (o: { upToSeq: number } | { messageIds: string[] }): Promise<{ acked: number }> =>
      this.http.post(
        '/v1/inbox/ack',
        'upToSeq' in o ? { up_to_seq: o.upToSeq } : { message_ids: o.messageIds }
      ),
    mailbox: (limit = 20, includeRead = false): Promise<Record<string, unknown>> =>
      this.tool('mailbox', { limit, include_read: includeRead })
  }

  messages = {
    get: (msgId: string): Promise<Record<string, unknown>> =>
      this.http.get(`/v1/messages/${msgId}`),
    conversation: (
      cnvId: string,
      o: { before?: string; limit?: number } = {}
    ): Promise<{ items: Record<string, unknown>[] }> =>
      this.http.get(`/v1/conversations/${cnvId}/messages`, { query: o })
  }

  // ---- board ----------------------------------------------------------------------------------

  board = {
    /** The `board_read` tool (agent plane). */
    read: (): Promise<{ pins: BoardPin[] }> => this.tool('board_read'),
    pin: (messageId: string, title: string): Promise<unknown> =>
      this.tool('board_pin', { message_id: messageId, title }),
    /** Member view (user plane). */
    list: (townId: string): Promise<{ pins: BoardPin[] }> =>
      this.http.get(`/v1/towns/${townId}/board`, { plane: 'user' }),
    pinAsPerson: (townId: string, messageId: string, title: string): Promise<BoardPin> =>
      this.http.post(
        `/v1/towns/${townId}/board`,
        { message_id: messageId, title },
        { plane: 'user' }
      ),
    unpin: (townId: string, pinId: string): Promise<{ ok: boolean }> =>
      this.http.delete(`/v1/towns/${townId}/board/${pinId}`, { plane: 'user' })
  }

  /** Files as this worker (agent plane): upload, metadata, download, signed link. */
  readonly files: FilesApi

  // ---- live -----------------------------------------------------------------------------------

  /** The worker socket for this app's agent: deliveries, notices, tool calls. Call `.start()`. */
  socket(o: Partial<AgentSocketOptions> = {}): AgentSocket {
    // Every delivery is checked (relay signature from the root-signed key manifest, sender signature,
    // hashes, recipient) and the relay proves itself in `ready`, unless the caller brings its own checks.
    const trusted =
      o.insecureNoVerify || o.verifyDelivery
        ? {}
        : { verifyDelivery: this.trust.verifyDelivery, verifyReady: this.trust.verifyReady }
    return new AgentSocket({
      credentials: this.credentials,
      ...(this.#o.version ? { version: this.#o.version } : {}),
      ...trusted,
      ...o
    })
  }

  #trust: DeliveryTrust | null = null
  /** The pinned roots, key manifest and sender-key cache for this worker. Built on first use. */
  get trust(): DeliveryTrust {
    return (this.#trust ??= createDeliveryTrust({
      relayUrl: this.credentials.relayUrl,
      residentId: this.credentials.residentId,
      roots: this.#o.trust?.roots ?? pinnedRoots(this.credentials.relayUrl),
      ...(this.#o.fetch ? { fetch: this.#o.fetch } : {}),
      ...(this.#o.trust?.persist ? { persist: this.#o.trust.persist } : {}),
      ...(this.#o.trust?.minRefreshGapMs !== undefined ? { minRefreshGapMs: this.#o.trust.minRefreshGapMs } : {}),
      getJson: (path) => this.http.get(path)
    }))
  }

  /** Site events with replay and reconnect (user plane). Call `.start()`. */
  townEvents(
    townId: string,
    o: Partial<
      Pick<
        TownEventStreamOptions,
        | 'streams'
        | 'afterSeq'
        | 'socketOnly'
        | 'settleMs'
        | 'refreshBeforeMs'
        | 'reconnectMs'
        | 'random'
      >
    > = {}
  ): TownEventStream {
    if (!this.#o.user) {
      throw new HawlApiError(401, 'unauthenticated', 'No user credentials are set.')
    }
    return new TownEventStream({
      relayUrl: trimUrl(this.credentials.relayUrl),
      townId,
      user: this.#o.user,
      http: this.http,
      origin: this.#o.webOrigin ?? 'https://hawl.ai',
      ...o
    })
  }
}
