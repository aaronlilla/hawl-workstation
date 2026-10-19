// HawlClient: typed calls to the relay. Two auth planes, as on the relay itself:
//   agent plane: this app's worker (AgentToken from the device-code key). /v1/me, tools, handoffs, files, channels, inbox.
//   user plane:  the person (UserJWT from a TokenSource you supply). Approvals, asks, board, needs-action, site events.
// Routes read from apps/relay/src/http/routes and the feature route files, 2026-10-19.
import { createHash } from 'node:crypto'
import {
  type Credentials,
  type FetchLike,
  HawlApiError,
  type Sleep,
  type TokenSource,
  trimUrl
} from './core'
import { AgentSocket, type AgentSocketOptions } from './agent-socket'
import { AgentTokenSource, Http } from './http'
import { Sender } from './send'
import type {
  Channel,
  FileMeta,
  HandoffCreate,
  HandoffEvidence,
  HandoffOp,
  HandoffState,
  Me,
  WorkerRow
} from './types'

export type * from './types'
import { type ConsoleStreamName, TownEventStream } from './town-events'

export type ClientOptions = {
  credentials: Credentials
  /** UserJWT source for the user plane. Without it those calls throw 401 before touching the network. */
  user?: TokenSource
  fetch?: FetchLike
  sleep?: Sleep
  maxRetries?: number
  /** Sent as the Origin of the console socket; must equal the relay's web origin. Default https://hawl.ai. */
  webOrigin?: string
  version?: string
}

export class HawlClient {
  readonly credentials: Credentials
  readonly http: Http
  readonly #o: ClientOptions
  readonly #agent: AgentTokenSource

  constructor(o: ClientOptions) {
    this.#o = o
    this.credentials = o.credentials
    this.#agent = new AgentTokenSource(o.credentials, o.fetch ? { fetch: o.fetch } : {})
    this.http = new Http({
      baseUrl: o.credentials.relayUrl,
      agent: this.#agent,
      ...(o.user ? { user: o.user } : {}),
      ...(o.fetch ? { fetch: o.fetch } : {}),
      ...(o.sleep ? { sleep: o.sleep } : {}),
      ...(o.maxRetries !== undefined ? { maxRetries: o.maxRetries } : {})
    })
  }

  // ---- identity -------------------------------------------------------------------------------

  me(): Promise<Me> {
    return this.http.get('/v1/me')
  }
  /** Sites the person belongs to, with the Do now count (user plane). */
  mySites(): Promise<{
    sites: { town_id: string; slug: string; name: string; role: string; do_now: number }[]
  }> {
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

  // ---- workers --------------------------------------------------------------------------------

  workers = {
    /** Active workers in this site. `q` matches handle or display name. */
    list: (q?: string): Promise<{ items: WorkerRow[] }> =>
      this.http.get('/v1/directory/residents', { query: { q, scope: 'town' } }),
    /** The `who` tool: status, what each is working on, owner and yard. */
    who: (query?: string): Promise<{ workers: Record<string, unknown>[] }> =>
      this.tool('who', query ? { query } : {}),
    /** Agent's inbox as seen by a member (user plane). Metadata only. */
    inboxOf: (townId: string, resId: string): Promise<unknown> =>
      this.http.get(`/v1/towns/${townId}/agents/${resId}/inbox`, { plane: 'user' })
  }

  // ---- handoffs (hauls) -----------------------------------------------------------------------

  handoffs = {
    list: (
      o: { state?: HandoffState; mine?: boolean } = {}
    ): Promise<{ handoffs: Record<string, unknown>[] }> => this.tool('handoff_list', o),
    get: (id: string): Promise<Record<string, unknown>> => this.http.get(`/v1/handoffs/${id}`),
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
    /** A person sends a work order (user plane). `to` is a handle or "auto". */
    send: (townId: string, body: Record<string, unknown>): Promise<Record<string, unknown>> =>
      this.http.post(`/v1/towns/${townId}/handoffs`, body, { plane: 'user' }),
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
    list: (
      townId: string,
      state: 'pending' | 'approved' | 'denied' | 'expired' = 'pending'
    ): Promise<{ items: Record<string, unknown>[] }> =>
      this.http.get(`/v1/towns/${townId}/approvals`, { plane: 'user', query: { state } }),
    approve: (aprId: string, note?: string): Promise<Record<string, unknown>> =>
      this.http.post(`/v1/approvals/${aprId}/approve`, note ? { note } : {}, { plane: 'user' }),
    deny: (aprId: string, note?: string): Promise<Record<string, unknown>> =>
      this.http.post(`/v1/approvals/${aprId}/deny`, note ? { note } : {}, { plane: 'user' })
  }

  asks = {
    /** Ask the site owner. `new:false` means this person already asked in the last 24 h. */
    askOwner: (
      townId: string,
      source: unknown,
      handoffId?: string
    ): Promise<{ sent: boolean; new: boolean; owner_user_id: string; asked_at: string }> =>
      this.http.post(
        `/v1/towns/${townId}/asks`,
        { source, ...(handoffId ? { handoff_id: handoffId } : {}) },
        { plane: 'user' }
      )
  }

  needs = {
    list: (
      townId: string,
      tab: 'needs' | 'later' | 'done' = 'needs'
    ): Promise<Record<string, unknown>> =>
      this.http.get(`/v1/towns/${townId}/needs-action`, { plane: 'user', query: { tab } }),
    done: (townId: string, itemId: string): Promise<unknown> =>
      this.http.post(
        `/v1/towns/${townId}/needs-action/done`,
        { item_id: itemId },
        { plane: 'user' }
      ),
    snooze: (townId: string, itemId: string, preset: string, utcOffsetMin = 0): Promise<unknown> =>
      this.http.post(
        `/v1/towns/${townId}/needs-action/snooze`,
        { item_id: itemId, preset, utc_offset_min: utcOffsetMin },
        { plane: 'user' }
      )
  }

  // ---- channels (square and rooms) ------------------------------------------------------------

  channels = {
    list: (): Promise<{ items: Channel[] }> => this.http.get('/v1/channels'),
    create: (name: string, topic?: string): Promise<Channel> =>
      this.http.post('/v1/channels', { name, ...(topic ? { topic } : {}) }),
    join: (chnId: string, wakeOn?: unknown): Promise<Channel> =>
      this.http.post(`/v1/channels/${chnId}/join`, wakeOn === undefined ? {} : { wake_on: wakeOn }),
    /** A member posts from the app (user plane). */
    post: (
      townId: string,
      chnId: string,
      text: string,
      o: { mentions?: string[]; as?: string; files?: { file_id: string }[]; replyTo?: string } = {}
    ): Promise<{ message_id: string; state: string }> =>
      this.http.post(
        `/v1/towns/${townId}/channels/${chnId}/messages`,
        {
          text,
          ...(o.mentions ? { mentions: o.mentions } : {}),
          ...(o.as ? { as: o.as } : {}),
          ...(o.files ? { files: o.files } : {}),
          ...(o.replyTo ? { reply_to: o.replyTo } : {})
        },
        { plane: 'user' }
      ),
    thread: (townId: string, chnId: string, msgId: string): Promise<Record<string, unknown>> =>
      this.http.get(`/v1/towns/${townId}/channels/${chnId}/threads/${msgId}`, { plane: 'user' }),
    discussHandoff: (townId: string, hndId: string): Promise<Record<string, unknown>> =>
      this.http.post(`/v1/towns/${townId}/handoffs/${hndId}/discuss`, {}, { plane: 'user' })
  }

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
    read: (): Promise<{ pins: Record<string, unknown>[] }> => this.tool('board_read'),
    pin: (messageId: string, title: string): Promise<unknown> =>
      this.tool('board_pin', { message_id: messageId, title }),
    /** Member view (user plane). */
    list: (townId: string): Promise<{ pins: Record<string, unknown>[] }> =>
      this.http.get(`/v1/towns/${townId}/board`, { plane: 'user' }),
    pinAsPerson: (
      townId: string,
      messageId: string,
      title: string
    ): Promise<Record<string, unknown>> =>
      this.http.post(
        `/v1/towns/${townId}/board`,
        { message_id: messageId, title },
        { plane: 'user' }
      ),
    unpin: (townId: string, pinId: string): Promise<{ ok: boolean }> =>
      this.http.delete(`/v1/towns/${townId}/board/${pinId}`, { plane: 'user' })
  }

  // ---- files ----------------------------------------------------------------------------------

  files = {
    meta: (filId: string): Promise<FileMeta> => this.http.get(`/v1/files/${filId}`),
    /** Bytes of a clean file. A held or flagged file is a 404. */
    download: (filId: string): Promise<Uint8Array> =>
      this.http.get(`/v1/files/${filId}/content`, { asBytes: true }),
    /** Short-lived signed link (user plane). */
    link: (filId: string): Promise<{ url: string; expires_in: number }> =>
      this.http.post(`/v1/files/${filId}/link`, {}, { plane: 'user' }),
    /**
     * Upload in two steps: declare (name, type, size, SHA-256), then PUT the bytes. The relay
     * scans afterwards, so the returned file id may report `scanning` for a moment.
     */
    upload: async (
      name: string,
      bytes: Uint8Array,
      mime: string
    ): Promise<{ upl_id: string; put_url: string; result: Record<string, unknown> }> => {
      const sha256 = createHash('sha256').update(bytes).digest('hex')
      const up = await this.http.post<{ upl_id: string; put_url: string; expires_in: number }>(
        '/v1/files/uploads',
        { name, mime, bytes: bytes.length, sha256 }
      )
      const path = new URL(up.put_url, this.http.baseUrl).pathname
      const result = await this.http.put<Record<string, unknown>>(path, {
        rawBody: bytes,
        headers: { 'content-type': 'application/octet-stream' }
      })
      return { ...up, result }
    }
  }

  // ---- live -----------------------------------------------------------------------------------

  /** The worker socket for this app's agent: deliveries, notices, tool calls. Call `.start()`. */
  socket(o: Partial<AgentSocketOptions> = {}): AgentSocket {
    return new AgentSocket({
      credentials: this.credentials,
      ...(this.#o.version ? { version: this.#o.version } : {}),
      ...o
    })
  }

  /** Site events with replay and reconnect (user plane). Call `.start()`. */
  townEvents(
    townId: string,
    o: { streams?: readonly ConsoleStreamName[]; afterSeq?: number; socketOnly?: boolean } = {}
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
