// The worker socket's opening exchange (spec 04 5.2): hello -> signed auth -> ready.
// Nothing but hello, ready and error is looked at until the relay has proved itself; frames that arrive
// while `verifyReady` is still deciding (it may fetch the key manifest) are held and replayed in order.
import { randomBytes } from 'node:crypto'
import type WebSocket from 'ws'
import { b64url, type Credentials, HawlApiError, handshakeInput, signEd25519 } from './core'
import type { AgentSocketOptions, Hello, Ready } from './agent-socket-types'

export type HandshakeHost = {
  ws: WebSocket
  credentials: Credentials
  version: string
  verifyReady: AgentSocketOptions['verifyReady']
  /** The socket this handshake belongs to is still the current one. */
  current(): boolean
  onHello(): void
  onError(e: HawlApiError): void
  /** The relay is verified. Called before `replay`. */
  onReady(r: Ready): void
  replay(frames: Record<string, unknown>[]): void
}

const MAX_HELD = 2000

export class Handshake {
  /** Set once a `ready` frame has been accepted. */
  ready = false
  /** We closed it ourselves because the relay could not be trusted: not an auth failure of this worker. */
  untrusted = false
  readonly #h: HandshakeHost
  readonly #held: Record<string, unknown>[] = []
  #hello: Hello | null = null
  #nonce = ''
  #verifying = false
  #overflow = false

  constructor(host: HandshakeHost) {
    this.#h = host
  }

  feed(f: Record<string, unknown>): void {
    if (this.#verifying) {
      if (this.#held.length < MAX_HELD) {
        this.#held.push(f)
      } else if (!this.#overflow) {
        // Never drop quietly: close so the relay pushes the unacked rows again after the reconnect.
        this.#overflow = true
        this.#h.onError(
          new HawlApiError(
            0,
            'handshake_overflow',
            'Too many frames arrived while the relay was being verified; reconnecting.'
          )
        )
        this.#h.ws.close(1013, 'handshake overflow')
      }
      return
    }
    if (f.t === 'hello' && !this.#hello) {
      this.#sendAuth(f as unknown as Hello)
    } else if (f.t === 'ready' && this.#hello) {
      this.#onReady(f as unknown as Ready, this.#hello)
    } else if (f.t === 'error') {
      const e = (f.error ?? {}) as { code?: string; message?: string }
      this.#h.onError(
        new HawlApiError(0, e.code ?? 'handshake_error', e.message ?? 'Handshake failed.')
      )
    }
    // Anything else is not trusted before ready.
  }

  #sendAuth(hello: Hello): void {
    const { credentials: c, ws } = this.#h
    this.#hello = hello
    this.#h.onHello()
    this.#nonce = b64url(randomBytes(32))
    const sig = signEd25519(
      c.privateJwk,
      handshakeInput({
        nonce: hello.nonce,
        clientNonce: this.#nonce,
        residentId: c.residentId,
        serverTime: hello.server_time
      })
    )
    ws.send(
      JSON.stringify({
        t: 'auth',
        resident_id: c.residentId,
        kid: c.kid,
        client_nonce: this.#nonce,
        sig: b64url(sig),
        client: { name: 'hawl-workstation', version: this.#h.version }
      })
    )
  }

  #refuse(code: string, message: string): void {
    this.untrusted = true
    this.#h.onError(new HawlApiError(0, code, message))
    this.#h.ws.close(4401, 'handshake refused')
  }

  #onReady(r: Ready, hello: Hello): void {
    if (r.resident_id !== this.#h.credentials.residentId) {
      this.#refuse('bad_ready', 'The relay answered for another worker.')
      return
    }
    const verify = this.#h.verifyReady
    if (!verify) {
      this.#accept(r)
      return
    }
    this.#verifying = true
    Promise.resolve()
      .then(() => verify(hello, r, this.#nonce))
      .catch(() => false)
      .then((ok) => {
        if (!this.#h.current()) {
          return
        }
        this.#verifying = false
        if (!ok) {
          this.#refuse('relay_not_trusted', 'The relay identity did not verify.')
          return
        }
        this.#accept(r)
        this.#h.replay(this.#held.splice(0))
      })
  }

  #accept(r: Ready): void {
    this.ready = true
    this.#h.onReady(r)
  }
}
