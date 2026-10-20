// The person's side of a site (user plane): approvals, asks to the owner, the Do now list.
import {
  ASK_SOURCES,
  type ApprovalItem,
  type AskSource,
  type NeedsList,
  type SnoozePreset
} from './types'
import { HawlApiError } from './core'
import type { Http } from './http'

export function approvalsApi(getHttp: () => Http) {
  return {
    /**
     * The relay returns the 100 OLDEST rows in that state and has no cursor. `truncated` is true when
     * the page is full: newer approvals may exist that this call cannot see (needs a relay change).
     */
    list: async (
      townId: string,
      state: 'pending' | 'approved' | 'denied' | 'expired' = 'pending'
    ): Promise<{ items: ApprovalItem[]; truncated: boolean }> => {
      const r = await getHttp().get<{ items: ApprovalItem[] }>(`/v1/towns/${townId}/approvals`, {
        plane: 'user',
        query: { state }
      })
      return { items: r.items, truncated: (r.items?.length ?? 0) >= 100 }
    },
    approve: (aprId: string, note?: string): Promise<Record<string, unknown>> =>
      getHttp().post(`/v1/approvals/${aprId}/approve`, note ? { note } : {}, { plane: 'user' }),
    deny: (aprId: string, note?: string): Promise<Record<string, unknown>> =>
      getHttp().post(`/v1/approvals/${aprId}/deny`, note ? { note } : {}, { plane: 'user' })
  }
}

export function asksApi(getHttp: () => Http) {
  return {
    /** Ask the site owner. `new:false` means this person already asked in the last 24 h. */
    askOwner: async (
      townId: string,
      source: AskSource,
      handoffId?: string
    ): Promise<{ sent: boolean; new: boolean; owner_user_id: string; asked_at: string }> => {
      if (!(ASK_SOURCES as readonly string[]).includes(source)) {
        throw new HawlApiError(
          400,
          'invalid_request',
          `Bad source. Use one of: ${ASK_SOURCES.join(', ')}.`
        )
      }
      return getHttp().post(
        `/v1/towns/${townId}/asks`,
        { source, ...(handoffId ? { handoff_id: handoffId } : {}) },
        { plane: 'user' }
      )
    }
  }
}

export function needsApi(getHttp: () => Http) {
  return {
    list: (townId: string, tab: 'needs' | 'later' | 'done' = 'needs'): Promise<NeedsList> =>
      getHttp().get(`/v1/towns/${townId}/needs-action`, { plane: 'user', query: { tab } }),
    done: (townId: string, itemId: string): Promise<unknown> =>
      getHttp().post(
        `/v1/towns/${townId}/needs-action/done`,
        { item_id: itemId },
        { plane: 'user' }
      ),
    snooze: (
      townId: string,
      itemId: string,
      preset: SnoozePreset,
      utcOffsetMin = 0
    ): Promise<unknown> =>
      getHttp().post(
        `/v1/towns/${townId}/needs-action/snooze`,
        { item_id: itemId, preset, utc_offset_min: utcOffsetMin },
        { plane: 'user' }
      )
  }
}
