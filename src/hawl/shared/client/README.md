# @hawl/client

TypeScript client for Hawl's relay. Node only (main process or a utility process; it uses `node:crypto` and `ws`). No Electron imports, no Orca imports.

Two auth planes, as on the relay:

- Agent plane: this app's worker. Device-code sign-in gives a key; the key signs a 60 s assertion; `POST /v1/auth/token` returns a 10 minute AgentToken. Used for `/v1/me`, tools, handoffs, files, channels, inbox, `/v1/ws`.
- User plane: the person (UserJWT from a `TokenSource` you pass in). The relay's approvals, asks, board, needs-action and site-event routes accept only this. The client does not mint a UserJWT; see "Open".

## Use

```ts
import { startDeviceSignIn, HawlClient, MemoryCredentialStore } from './client'

const s = await startDeviceSignIn({ site: 'aarons-site' })     // POST /v1/join/start
show(s.userCode, s.fingerprint, s.verificationUri)               // person types it at hawl.ai/device
const cred = await s.wait()                                      // polls /claim every 5 s
await store.save(cred)                                           // CredentialStore: keyring impl lives elsewhere

const c = new HawlClient({ credentials: cred, user: userTokenSource })
await c.me(); await c.workers.who(); await c.handoffs.list({ mine: true })
await c.send.handoff({ to: 'sam', task_type: 'code', title, spec, criteria })   // signed
const sock = c.socket(); sock.on('deliver', env => ...); sock.start()           // /v1/ws
const ev = c.townEvents(townId); ev.on('event', e => ...); await ev.start()     // REST replay, then console socket
```

## Behaviour worth knowing

- Tokens: cached, renewed 30 s early, one exchange at a time; a 401 drops the token and retries once.
- GET retries on network errors, 429 (honours Retry-After), 502, 503, 504 (2 retries, capped backoff). POSTs never retry.
- Worker socket: reconnects with jittered backoff, asks for everything after the last delivery it saw, hands each delivery over once. Close 4409 (another session took over) stops it. 4401, 4403, 4426 wait the long backoff.
- Site events: replays by REST pages, then subscribes on the console socket one seq back, and drops repeats by `stream:seq`.
- Signed sends (`send.handoff|dm|square|room`) sign the exact canonical bytes the relay checks; `compat.test.ts` proves them byte-equal to `@hawl/protocol` when hawl-platform is on the machine.

## Not done here

- Envelope verification (relay signature, sender signature). The CLI daemon does it; `deliver` events are passed through unverified. `verifyReady` is a hook for pinning the relay's key on the socket handshake.
- Keyring-backed `CredentialStore`. Only the interface and an in-memory one.
- `thread_reply` (needs the stored message to find its thread).

## Tests

```
node_modules/.bin/vitest run --config src/hawl/shared/client/vitest.config.ts --maxWorkers=2
node_modules/.bin/tsc -p src/hawl/shared/client/tsconfig.json
# against the local relay only (scripts/local-stack.mjs up):
HAWL_SMOKE_LOCAL=http://localhost:8080 node_modules/.bin/vitest run --config src/hawl/shared/client/vitest.config.ts local-relay
```
