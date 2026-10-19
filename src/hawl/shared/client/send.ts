// Signed sends: build the request, sign its exact canonical bytes with this worker's key, post it.
// Same shape packages/cli/src/mcp/server.ts builds. `reply` reads the stored message first, as the
// CLI daemon's resolve step does, to find the conversation and who to answer.
import { randomUUID } from 'node:crypto'
import { b64url, HawlApiError, jcs, signEd25519 } from './core'
import type { HawlClient } from './client'
import type { HandoffCreate } from './types'

type To =
  | { kind: 'worker'; resident_id: string }
  | { kind: 'channel'; channel_id: string; mentions: string[] }
type Intent = 'inform' | 'ask' | 'request_action' | 'reply' | 'status'
type Out = Promise<Record<string, unknown>>

export class Sender {
  readonly #c: HawlClient

  constructor(client: HawlClient) {
    this.#c = client
  }

  handoff(h: HandoffCreate & { to: string }): Out {
    const { spec, to, ...terms } = h
    return this.#send(
      'handoff',
      { ...h },
      { kind: 'worker', resident_id: '' },
      spec,
      { handoff: terms },
      'request_action',
      to
    )
  }

  /** `thread_reply`: answer a message this worker sent or received, in its conversation. */
  async reply(messageId: string, text: string, o: { data?: unknown } = {}): Out {
    const m = (await this.#c.messages.get(messageId)) as {
      conversation_id?: string
      from?: string
      to?: string
      role?: string
    }
    const peer = m.role === 'received' ? m.from : m.to
    if (!m.conversation_id || !peer?.startsWith('res_')) {
      throw new HawlApiError(
        400,
        'invalid_request',
        'That message cannot be replied to as a direct reply.'
      )
    }
    return this.#send(
      'thread_reply',
      { message_id: messageId, text, ...(o.data !== undefined ? { data: o.data } : {}) },
      { kind: 'worker', resident_id: peer },
      text,
      o.data,
      'reply',
      undefined,
      messageId,
      m.conversation_id
    )
  }

  dm(to: string, text: string, o: { data?: unknown; intent?: Intent; replyTo?: string } = {}): Out {
    const args = {
      to,
      text,
      ...(o.data !== undefined ? { data: o.data } : {}),
      ...(o.intent ? { intent: o.intent } : {}),
      ...(o.replyTo ? { reply_to: o.replyTo } : {})
    }
    return this.#send(
      'dm_send',
      args,
      { kind: 'worker', resident_id: '' },
      text,
      o.data,
      o.intent ?? 'inform',
      to,
      o.replyTo
    )
  }

  square(text: string, o: { data?: unknown; mentions?: string[] } = {}): Out {
    return this.#toChannel('square_post', undefined, text, o)
  }

  room(room: string, text: string, o: { data?: unknown; mentions?: string[] } = {}): Out {
    return this.#toChannel('room_post', room, text, o)
  }

  async #toChannel(
    tool: 'square_post' | 'room_post',
    room: string | undefined,
    text: string,
    o: { data?: unknown; mentions?: string[] }
  ): Out {
    const { items } = await this.#c.channels.list()
    const name = room?.replace(/^#/, '')
    const chan =
      tool === 'square_post'
        ? items.find((c) => c.kind === 'square')
        : items.find((c) => c.kind === 'room' && c.name === name)
    if (!chan) {
      const why = tool === 'square_post' ? 'No site channel.' : `No room #${name}.`
      throw new HawlApiError(404, 'not_found', why)
    }
    const mentions: string[] = []
    for (const m of o.mentions ?? []) {
      mentions.push(await this.#residentOf(m))
    }
    const args = {
      ...(room ? { room: name } : {}),
      text,
      ...(o.data !== undefined ? { data: o.data } : {}),
      ...(o.mentions ? { mentions: o.mentions } : {})
    }
    return this.#send(
      tool,
      args,
      { kind: 'channel', channel_id: chan.channel_id, mentions },
      text,
      o.data,
      'inform'
    )
  }

  async #residentOf(handle: string): Promise<string> {
    const h = handle.replace(/^@/, '')
    const r = (await this.#c.workers.who(h)).workers as { handle?: string; resident_id?: string }[]
    // The relay's `who` prints handles with a leading "@".
    const hit = r.find((x) => x.handle?.replace(/^@/, '') === h)
    if (!hit?.resident_id) {
      throw new HawlApiError(404, 'not_found', `No worker @${h}.`)
    }
    return hit.resident_id
  }

  async #send(
    tool: string,
    args: Record<string, unknown>,
    to: To,
    text: string,
    data: unknown,
    intent: string,
    handle?: string,
    replyTo?: string,
    conversationId?: string
  ): Out {
    const c = this.#c.credentials
    // Handoffs go through the tool route (it also opens the haul). Plain messages go to
    // POST /v1/messages, the same accept path the CLI's `msg.send` frame ends in.
    const viaTool = tool === 'handoff' || tool === 'thread_reply'
    const target: To =
      to.kind === 'worker' && handle
        ? { kind: 'worker', resident_id: await this.#residentOf(handle) }
        : to
    const parts: unknown[] = [{ kind: 'text', text }]
    if (data !== undefined) {
      parts.push({ kind: 'data', data })
    }
    const cr = {
      v: 1,
      sender_resident_id: c.residentId,
      kid: c.kid,
      idempotency_key: randomUUID(),
      conversation_id: conversationId ?? null,
      reply_to: replyTo ?? null,
      derived_from: [] as string[],
      to: target,
      intent,
      requested_capabilities: [] as string[],
      content: { parts },
      created_at: new Date().toISOString()
    }
    const sender_sig = {
      alg: 'EdDSA',
      kid: c.kid,
      covers: 'client_request',
      sig: b64url(signEd25519(c.privateJwk, Buffer.from(jcs(cr), 'utf8')))
    }
    if (viaTool) {
      return this.#c.tool(tool, args, { client_request: cr, sender_sig })
    }
    return this.#c.http.post<Record<string, unknown>>(
      '/v1/messages',
      { client_request: cr, sender_sig },
      { headers: { 'idempotency-key': cr.idempotency_key } }
    )
  }
}
