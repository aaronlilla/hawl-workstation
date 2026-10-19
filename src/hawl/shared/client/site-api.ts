// User-plane routes beyond the core set in client.ts: worker controls, person file upload and delete,
// proof history, limit pauses, safety switches and the weekly meter. All need a UserJWT.
// Routes read from apps/relay/src (agents/routes.ts, files/routes.ts, limits, needs, meter,
// http/routes/switches.ts, http/routes/handoff-history.ts), 2026-10-19.
import { twoStepUpload, type UploadResult } from './files-api'
import type { Http, Plane } from './http'
import type { Meter, SwitchesState, WorkerOverview } from './types'

export class SiteApi {
  readonly #http: Http

  constructor(http: Http) {
    this.#http = http
  }

  /** Approving a device that is signing in with a code (hawl.ai/device), and join decisions. */
  joins = {
    /** Step 1: the code the person read off the device. Binds the request to this person. */
    lookup: (
      userCode: string
    ): Promise<{ join_id: string; key_fingerprint: string } & Record<string, unknown>> =>
      this.#http.post('/v1/join/lookup', { user_code: userCode }, { plane: 'user' }),
    /** Step 2: confirm the key fingerprint the device showed matches what the page showed. */
    approveDevice: (
      joinId: string,
      userCode: string,
      keyFingerprint: string
    ): Promise<{ ok: boolean }> =>
      this.#http.post(
        `/v1/join/${joinId}/approve-device`,
        { user_code: userCode, key_fingerprint: keyFingerprint },
        { plane: 'user' }
      ),
    /** An owner's decision on a worker that asked to join the site. */
    decide: (
      townId: string,
      joinId: string,
      decision: 'approve' | 'deny'
    ): Promise<Record<string, unknown>> =>
      this.#http.post(`/v1/towns/${townId}/joins/${joinId}/${decision}`, {}, { plane: 'user' })
  }

  workers = {
    /** Every worker in the site with owner, yard and live state (member view). */
    list: (townId: string): Promise<{ items: WorkerOverview[] }> =>
      this.#http.get(`/v1/towns/${townId}/workers`, { plane: 'user' }),
    pause: (townId: string, resId: string): Promise<Record<string, unknown>> =>
      this.#http.post(`/v1/towns/${townId}/workers/${resId}/pause`, {}, { plane: 'user' }),
    resume: (townId: string, resId: string): Promise<Record<string, unknown>> =>
      this.#http.post(`/v1/towns/${townId}/workers/${resId}/resume`, {}, { plane: 'user' }),
    /** Who may message this worker. `senders` is the relay's list shape (handles or ids). */
    setTrustedSenders: (
      townId: string,
      resId: string,
      senders: unknown
    ): Promise<Record<string, unknown>> =>
      this.#http.put(`/v1/towns/${townId}/workers/${resId}/trusted-senders`, {
        plane: 'user',
        body: { senders }
      }),
    setLabel: (townId: string, resId: string, label: string): Promise<Record<string, unknown>> =>
      this.#http.put(`/v1/towns/${townId}/agents/${resId}/label`, {
        plane: 'user',
        body: { label }
      })
  }

  files = {
    /**
     * A person shares a file (it rides on their next message). Two steps like the agent upload:
     * declare, then PUT the bytes to the URL the relay returned.
     */
    upload: (
      townId: string,
      name: string,
      bytes: Uint8Array,
      mime: string,
      o: { as?: string } = {}
    ): Promise<UploadResult> =>
      twoStepUpload(
        this.#http,
        'user',
        `/v1/towns/${townId}/files/uploads`,
        name,
        bytes,
        mime,
        o.as ? { as: o.as } : {}
      ),
    /** Remove a file this person shared. */
    delete: (filId: string): Promise<Record<string, unknown>> =>
      this.#http.delete(`/v1/files/${filId}`, { plane: 'user' })
  }

  /** The signed history of a haul. Open to a member (user plane) or an agent in the site (agent plane). */
  handoffHistory = {
    list: (hndId: string, plane: Plane = 'user'): Promise<Record<string, unknown>> =>
      this.#http.get(`/v1/handoffs/${hndId}/history`, { plane }),
    entry: (
      hndId: string,
      entry: number,
      plane: Plane = 'user'
    ): Promise<Record<string, unknown>> =>
      this.#http.get(`/v1/handoffs/${hndId}/history/${entry}`, { plane })
  }

  limits = {
    /** Why a haul is paused on a usage limit, if it is. */
    pause: (townId: string, hndId: string): Promise<Record<string, unknown>> =>
      this.#http.get(`/v1/towns/${townId}/handoffs/${hndId}/limit-pause`, { plane: 'user' }),
    resume: (townId: string, hndId: string): Promise<{ resumed: boolean }> =>
      this.#http.post(`/v1/towns/${townId}/handoffs/${hndId}/resume`, {}, { plane: 'user' })
  }

  needsUndo = (townId: string, itemId: string): Promise<unknown> =>
    this.#http.post(`/v1/towns/${townId}/needs-action/undo`, { item_id: itemId }, { plane: 'user' })

  switches = {
    get: (townId: string): Promise<SwitchesState> =>
      this.#http.get(`/v1/towns/${townId}/settings/switches`, { plane: 'user' }),
    /** Set one or more switches; the relay answers with the new state. */
    set: (townId: string, changes: Record<string, unknown>): Promise<SwitchesState> =>
      this.#http.put(`/v1/towns/${townId}/settings/switches`, { plane: 'user', body: changes }),
    freeze: (townId: string): Promise<Record<string, unknown>> =>
      this.#http.post(`/v1/towns/${townId}/freeze`, {}, { plane: 'user' }),
    unfreeze: (townId: string): Promise<Record<string, unknown>> =>
      this.#http.post(`/v1/towns/${townId}/unfreeze`, {}, { plane: 'user' })
  }

  /** The site's weekly usage meter. `week` is the relay's week key (default: this week). */
  meter = (townId: string, week?: string): Promise<Meter> =>
    this.#http.get(`/v1/towns/${townId}/meter`, { plane: 'user', query: { week } })
}
