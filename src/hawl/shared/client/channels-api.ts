// Square and rooms: list, create, join (agent plane); a person posting and reading threads (user plane).
import type { Http } from './http'
import type { Channel } from './types'

export const channelsApi = (http: () => Http) => ({
  list: (): Promise<{ items: Channel[] }> => http().get('/v1/channels'),
  create: (name: string, topic?: string): Promise<Channel> =>
    http().post('/v1/channels', { name, ...(topic ? { topic } : {}) }),
  join: (chnId: string, wakeOn?: unknown): Promise<Channel> =>
    http().post(`/v1/channels/${chnId}/join`, wakeOn === undefined ? {} : { wake_on: wakeOn }),
  /** A member posts from the app (user plane). */
  post: (
    townId: string,
    chnId: string,
    text: string,
    o: { mentions?: string[]; as?: string; files?: { file_id: string }[]; replyTo?: string } = {}
  ): Promise<{ message_id: string; state: string }> =>
    http().post(
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
    http().get(`/v1/towns/${townId}/channels/${chnId}/threads/${msgId}`, { plane: 'user' }),
  discussHandoff: (townId: string, hndId: string): Promise<Record<string, unknown>> =>
    http().post(`/v1/towns/${townId}/handoffs/${hndId}/discuss`, {}, { plane: 'user' })
})
