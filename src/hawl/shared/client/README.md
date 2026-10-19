# @hawl/client

TypeScript client for Hawl's relay. Node only (main process or a utility process; it uses `node:crypto` and `ws`). No Electron imports, no Orca imports.

Two auth planes, as on the relay:

- Agent plane: this app's worker. Device-code sign-in gives a key; the key signs a 60 s assertion; `POST /v1/auth/token` returns a 10 minute AgentToken. Used for `/v1/me`, tools, handoffs, files, channels, inbox, `/v1/ws`.
- User plane: the person. Approvals, asks, board, needs-action, site events, worker controls, switches and the meter accept only a UserJWT. The web app mints it at `GET /api/relay-token` for a signed-in session cookie. `WebSession` signs in the way the browser does (emailed 6-digit code, Better Auth emailOTP), keeps the cookie, and is the `TokenSource` for the client. A passkey or OAuth sign-in done in a browser window works too: pass its cookie header to `WebSession.fromCookie`.

## Use

```ts
import { startDeviceSignIn, HawlClient, WebSession } from './client'

// 1. The person: emailed code -> web session -> UserJWTs
await WebSession.sendCode('me@x.com')
const session = await WebSession.verifyCode('me@x.com', '123456', { onCookie: saveCookie })

// 2. This app's worker: device code, approved on hawl.ai/device (or by the same person, see site.joins)
const s = await startDeviceSignIn({ site: 'aarons-site' })      // POST /v1/join/start
show(s.userCode, s.fingerprint, s.verificationUri)
const cred = await s.wait()                                      // polls /claim, rides out 429/5xx

const c = new HawlClient({ credentials: cred, user: session })
await c.me(); await c.mySites(); await c.approvals.list(cred.townId)
await c.send.handoff({ to: 'sam', task_type: 'code', title, spec, criteria })   // signed
await c.send.reply(messageId, 'on it')                                           // thread_reply, signed
const sock = c.socket(); sock.on('deliver', env => ...); sock.start()           // /v1/ws
const ev = c.townEvents(cred.townId); ev.on('event', e => ...); await ev.start() // REST replay, then console socket
```

Persisting a sign-in: `FileCredentialStore(path, cipher)` and `EncryptedFile` (for the web cookie) write encrypted files. The cipher is a seam: pass Electron `safeStorage` (DPAPI / Keychain / libsecret) from the main process, or `aesGcmCipher(key)` with a key from the OS keyring. A file that will not decrypt reads as signed out.

## Behaviour worth knowing

- Tokens: cached, renewed early, one exchange at a time; a 401 drops the token and retries once. `WebSession` answers `session_expired` when the site says 401 and clears the stored cookie.
- GET retries on network errors, 429 (honours Retry-After), 502, 503, 504 (2 retries, capped backoff). POSTs never retry.
- Sign-in polling: 202 pending; 408/425/429/5xx and network errors keep polling (Retry-After honoured); 4xx otherwise is `code_expired`.
- Worker socket: reconnects with jittered backoff and asks for everything after the last delivery it saw, handing each over once. 4409 (another session took over) parks it in `replaced`; call `start()` to take it back. 4401, 4403, 4426, 4429 wait the long backoff; 4503 (restart) waits at least 3 s. `start()` is idempotent.
- `verifyDelivery(env)` option: checked on every delivery, in arrival order. A failing one is emitted as `dropped {envelope, reason}`, never as `deliver`, and never acked. No verifier is bundled yet (see below).
- Site events: replays by REST pages, then subscribes on the console socket one seq back, drops repeats by `stream:seq`. The relay never confirms `auth`, so the socket counts as live (and the backoff resets) only after it stays open `settleMs` (1.5 s) or delivers a frame; a relay that refuses auth every time is retried with growing waits. A fresh `auth` is sent `refreshBeforeMs` (90 s) before the UserJWT expires, so the socket outlives one token.
- Signed sends (`send.handoff|dm|square|room|reply`) sign the exact canonical bytes the relay checks; `compat.test.ts` proves them byte-equal to `@hawl/protocol` when hawl-platform is on the machine.
- Uploads declare the SHA-256 as 43 base64url characters (the relay refuses hex). Your own upload is not downloadable (`release_state: "self"`) until a message carrying it reaches a reader.
- Types: the user-plane rows (approvals, needs-action, board pins, haul rows and detail, worker overview, switches, meter, `who`) are typed from what the relay returned on the local stack; unknown extra fields stay reachable through an index signature. Not every response is typed (haul actions, approve/deny results, conversation messages are `Record<string, unknown>`).

## Not done here

- Envelope verification itself (relay signature from the root-signed key manifest, sender signature). The CLI daemon does it in `packages/cli/src/daemon/verify.ts`; this client only has the `verifyDelivery` seam, and `verifyReady` for pinning the relay on the socket handshake.
- The keyring binding. The cipher seam is here and tested with AES-GCM; the Electron `safeStorage` wiring belongs to the main-process piece.
- No `@hawl/protocol` import at runtime (the fork cannot depend on hawl-platform); types are written here.
- Not exercised against the real relay: `site.workers.setTrustedSenders`, `setLabel`, `limits.*`, `needsUndo`, `files.link`, `site.joins.decide`, `approvals.approve` (deny is), `needs.done|snooze`, `asks.askOwner`, `handoffs.send|byPerson`, `switches.freeze|unfreeze`. These are covered by `routes.test.ts` only (method, path, plane, body). `channels.thread` and `discussHandoff` have no test.

## Tests

```
node_modules/.bin/vitest run --config src/hawl/shared/client/vitest.config.ts --maxWorkers=2
node_modules/.bin/tsc -p src/hawl/shared/client/tsconfig.json
node_modules/.bin/oxlint src/hawl
```

The smoke tests in `local-relay.smoke.test.ts` run by default when a loopback relay (:8080) and web (:3000) answer (`node scripts/local-stack.mjs up` in the hawl-platform e2e worktree), and skip with a warning otherwise. `HAWL_SMOKE_REQUIRE=1` turns a skip into a failure; `HAWL_SMOKE_LOCAL=off` skips on purpose. Non-loopback URLs are refused. They sign in through the real web app (code from the local e2e sink) and the relay's real lookup and approve-device routes; the only SQL is a read-only owner lookup (needs `pg` from `HAWL_PLATFORM_E2E`, default `E:/hawl-platform/.claude/worktrees/e2e`). Test workers leave the site when done.
