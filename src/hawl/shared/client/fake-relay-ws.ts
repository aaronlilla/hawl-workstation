// Fake relay: the agent socket (/v1/ws) and the console socket (/v1/console/ws).
import { randomUUID, verify as nodeVerify } from 'node:crypto'
import type { WebSocket } from 'ws'
import { handshakeInput } from './core'
import type { FakeEvent, FakeRelay } from './fake-relay'
import type { WorkerRec } from './fake-relay-ctx'

export function agentWs(r: FakeRelay, ws: WebSocket): void {
  const nonce = randomUUID().replace(/-/g, '').padEnd(43, 'x')
  const serverTime = new Date().toISOString()
  ws.send(
    JSON.stringify({
      t: 'hello',
      nonce,
      server_time: serverTime,
      relay_kid: r.trust?.relayKid ?? 'rk_test',
      protocol: 1
    })
  )
  let authed: WorkerRec | null = null
  ws.on('message', (raw) => {
    const f = JSON.parse(raw.toString()) as Record<string, unknown>
    if (!authed) {
      const w = r.workers.get(String(f.resident_id))
      const good =
        f.t === 'auth' &&
        w &&
        w.kid === f.kid &&
        nodeVerify(
          null,
          handshakeInput({
            nonce,
            clientNonce: String(f.client_nonce),
            residentId: w.id,
            serverTime
          }),
          w.pub,
          Buffer.from(String(f.sig), 'base64url')
        )
      if (!good || !w) {
        return void ws.close(4401, 'auth failed')
      }
      authed = w
      r.handshakes++
      r.agentConns.push(ws)
      ws.on('close', () => {
        r.agentConns = r.agentConns.filter((x) => x !== ws)
      })
      ws.send(
        JSON.stringify({
          t: 'ready',
          session_id: 'ses_1',
          resident_id: w.id,
          town_id: r.townId,
          pending: r.inbox.length,
          heartbeat_s: 25,
          relay_sig: r.trust
            ? r.trust.signReady({
                nonce,
                client_nonce: String(f.client_nonce),
                resident_id: w.id,
                session_id: 'ses_1',
                server_time: serverTime
              })
            : 'x'
        })
      )
      // The real relay pushes everything claimable after ready.
      for (const e of r.inbox) {
        ws.send(JSON.stringify({ t: 'deliver', envelope: e }))
      }
      return
    }
    if (f.t === 'inbox.fetch') {
      for (const e of r.inbox.filter((x) => seqOfEnv(x) > Number(f.after_seq))) {
        ws.send(JSON.stringify({ t: 'deliver', envelope: e }))
      }
      ws.send(JSON.stringify({ t: 'notice', unread: r.inbox.length, needs_action: 0 }))
    } else if (f.t === 'tool.call') {
      if (f.name === 'who') {
        ws.send(JSON.stringify({ t: 'tool.result', id: f.id, result: { workers: [] } }))
      } else {
        ws.send(
          JSON.stringify({
            t: 'tool.result',
            id: f.id,
            error: {
              code: 'invalid_request',
              message: 'Unknown tool.',
              request_id: 'r',
              retry_after: null
            }
          })
        )
      }
    } else if (f.t === 'ping') {
      ws.send(JSON.stringify({ t: 'pong', ts: f.ts }))
    }
  })
}

export function consoleWs(r: FakeRelay, ws: WebSocket): void {
  let authed = false
  r.consoleConns.push(ws)
  ws.on('close', () => {
    r.consoleConns = r.consoleConns.filter((x) => x !== ws)
  })
  ws.on('message', (raw) => {
    const f = JSON.parse(raw.toString()) as {
      t: string
      jwt?: string
      streams?: string[]
      after_seq?: number
    }
    if (f.t === 'auth') {
      r.consoleAuths.push(String(f.jwt))
      const ok = r.acceptJwt ? r.acceptJwt(String(f.jwt)) : f.jwt === r.userToken
      if (!ok || r.consoleRefuseAuth) {
        return void ws.close(4401, 'auth failed')
      }
      authed = true
      return
    }
    if (f.t === 'subscribe' && authed) {
      ;(ws as WebSocket & { sub?: unknown }).sub = { streams: f.streams }
      let sent = 0
      for (const e of r.events.filter((x) => x.seq > (f.after_seq ?? 0))) {
        pushEvent(r, ws, e)
        sent++
        if (r.consoleDropAfter && sent >= r.consoleDropAfter) {
          ws.close(1011, 'drop')
          return
        }
      }
    }
  })
}

export function pushEvent(r: FakeRelay, ws: WebSocket, e: FakeEvent): void {
  // One frame per stream, like the real relay (a single event can be in feed and needs_action).
  const streams: string[] = (e.streams as string[] | undefined) ?? ['feed']
  for (const t of streams) {
    ws.send(
      JSON.stringify({
        t,
        seq: e.seq,
        town_id: r.townId,
        at: '2026-10-19T00:00:00Z',
        event: e.event
      })
    )
  }
}

export function seqOfEnv(e: Record<string, unknown>): number {
  return (e.relay as { delivery: { inbox_seq: number } }).delivery.inbox_seq as number
}
