# @hawl/client

TypeScript client for Hawl's relay. Node only (main process or a utility process; it uses `node:crypto` and `ws`). No Electron imports, no Orca imports.

Two auth planes, as on the relay:

- Agent plane: this app's worker. Device-code sign-in gives a key; the key signs a 60 s assertion; `POST /v1/auth/token` returns a 10 minute AgentToken. Used for `/v1/me`, tools, handoffs, files, channels, inbox, `/v1/ws`.
- User plane: the person. Approvals, asks, board, needs-action, site events, worker controls, switches and the meter accept only a UserJWT. The web app mints it at `GET /api/relay-token` for a signed-in session cookie. `WebSession` signs in the way the browser does (emailed 6-digit code, Better Auth emailOTP), keeps the cookie, and is the `TokenSource` for the client. A passkey or OAuth sign-in done in a browser window works too: pass its cookie header to `WebSession.fromCookie`.

## Use

```ts
import { startDeviceSignIn, HawlClient, WebSession } from '@hawl/client'

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

Persisting a sign-in: `FileCredentialStore(path, cipher)` and `EncryptedFile` (for the web cookie) write encrypted files. The cipher is a seam: pass Electron `safeStorage` (DPAPI / Keychain / libsecret) from the main process, or `aesGcmCipher(key)` with a key from the OS keyring. A file that will not decrypt reads as signed out. `safeStorageCipher(safeStorage)` wraps Electron's `safeStorage` (it refuses when the OS cannot encrypt, so a key is never written in the clear). Saves on one `EncryptedFile` run one at a time in call order (last wins) with a unique temp name; two instances on one path do not collide either.

### The whole sign-in as one object

`WorkstationAccount` ties the pieces together and survives a restart. Decided here: the WORKER (this app's agent identity) signs in with the device code; the PERSON (approvals, board, site feed) signs in to the web app with the emailed code, or with a cookie taken from a browser window. The relay accepts no other way for the person.

```ts
import { WorkstationAccount, fileSecretStores, safeStorageCipher } from '@hawl/client'

const stores = fileSecretStores(app.getPath('userData') + '/hawl', safeStorageCipher(safeStorage)) // credentials.enc, web-cookie.enc
const acct = await WorkstationAccount.open({ stores })   // loads both; signed out if a file is missing or unreadable
acct.state                                                // { worker, person }
acct.client                                               // HawlClient or null; the same object after web sign-in/out
await acct.signInWorker({ site: 'aarons-site' }, { onCode: (s) => show(s.userCode, s.verificationUri), signal })
await acct.sendWebCode(email); await acct.verifyWebCode(email, '123456')   // or acct.useBrowserCookie(header)
await acct.signOutPerson()                                // worker stays signed in
await acct.signOutAll({ leave: true })                    // tell the relay (revokes keys), erase both files
```

A key the relay already handed over is kept in memory even if the disk refuses it (`onStorageError`, `storageProblem`). A stored sign-in that fails the https check is ignored (`loadProblem`). Cookie rotation and "session ended" are written through to the file.


## Behaviour worth knowing

- Tokens: cached, renewed early, one exchange at a time; a 401 drops the token and retries once. The exchange itself (agent token, and the web token mint) retries network errors, timeouts, 429 (honours Retry-After), 502, 503, 504, twice, signing a fresh assertion each try. 401 and other 4xx are not retried. `WebSession` answers `session_expired` when the site says 401 and clears the stored cookie.
- Deadlines: every network call has one (20 s by default; `timeoutMs` on `HawlClient`, `WebSession`, `startDeviceSignIn`, and per request). Headers and body are inside it. A stall fails with `HawlApiError` code `timeout`; GETs retry it like a network error. A shared token exchange that stalls fails for everyone waiting on it and the next call starts a new one. A caller's own `signal` still cancels (not reported as a timeout).
- GET retries on network errors, 429 (honours Retry-After), 502, 503, 504 (2 retries, capped backoff). POSTs never retry.
- Sign-in polling: 202 pending; 408/425/429/5xx and network errors keep polling (Retry-After honoured); 404/410 is `code_expired` (the relay answers 404 for expired, denied, unknown id, bad signature and a clock too far off, so the app cannot tell them apart; the message says all of that). Other 4xx keep the relay's own error code. A 200 that is not JSON, or lacks the ids, is `bad_response` and ends the wait (the relay may already have handed the key over). A `relay_url` in the claim answer is used only when it is https (or loopback) on the same host the person signed in against; otherwise the URL they chose is kept. Sign-in start, claim, token exchange, web sign-in and the web origin all refuse plain http to a non-loopback host.
- Worker socket: reconnects with jittered backoff and asks for everything after the last delivery it saw, handing each over once. 4409 (another session took over) parks it in `replaced`; call `start()` to take it back. 4401 and 4429 wait the long backoff; 4503 (restart) waits at least 3 s. 4403 (suspended or removed) and 4426 (client too old) end in the `refused` state with a `refused {code, reason}` event and no more retries; so do 5 failed handshakes in a row (`authStrikes`, reason `auth_failed`). `start()` takes a refused socket back. `start()` is idempotent.
- Trust (`verify.ts`, port of the CLI daemon's manifest/senderkeys/verify): `HawlClient.socket()` checks the relay on `ready` (its `relay_sig` against the key manifest, which is signed by a pinned offline root) and every `deliver` (schema, relay_sig, sender_sig via `GET /v1/keys/{kid}`, request_hash, view_sha256, recipient) before emitting it. A failing delivery is emitted as `dropped {envelope, reason}`, never as `deliver`, never acked. The manifest is fetched from `/.well-known/relay-key-manifest.json` on first use or when the relay key is unknown (at most once per 15 s), refuses rollback, expiry and revoked keys, and fails closed. Roots: the pinned production `root_1`, plus `HAWL_DEV_PINNED_ROOTS` only for loopback and staging relays; override with `new HawlClient({ trust: { roots, persist } })`. Building an `AgentSocket` with no `verifyDelivery` throws unless `insecureNoVerify: true` (tests).
- Site events: replays by REST pages, then subscribes on the console socket one seq back, drops repeats by `stream:seq`. The relay never confirms `auth`, so the socket counts as live (and the backoff resets) only after it stays open `settleMs` (1.5 s) or delivers a frame; a relay that refuses auth every time is retried with growing waits. A fresh `auth` is sent `refreshBeforeMs` (90 s) before the UserJWT expires, so the socket outlives one token.
- Signed sends (`send.handoff|dm|square|room|reply`) sign the exact canonical bytes the relay checks; `compat.test.ts` proves them byte-equal to `@hawl/protocol` when hawl-platform is on the machine.
- Uploads declare the SHA-256 as 43 base64url characters (the relay refuses hex). Your own upload is not downloadable (`release_state: "self"`) until a message carrying it reaches a reader.
- Types: the user-plane rows (approvals, needs-action, board pins, haul rows and detail, worker overview, switches, meter, `who`) are typed from what the relay returned on the local stack; unknown extra fields stay reachable through an index signature. Not every response is typed (haul actions, approve/deny results, conversation messages, and everything under `client.more` are `Record<string, unknown>`).
- `client.more`: invite link and joiners, reputation get/dispute/resolve, directory intro get/decide, weekly value, site and account exports, elevation veto. Paths and bodies read from the relay route files and checked by `round5.test.ts`; not run against a real relay. Not covered: guide routes, the export download (a signed link on the export row), the invite joiner list.

## Not done here

- Electron's real `safeStorage` is not bound here. `WorkstationAccount` and `fileSecretStores` take any `Cipher`; `safeStorageCipher(safeStorage)` and `aesGcmCipher(key)` are tested with stand-ins and a real AES key. The main-process piece passes the real one.
- `WebSession` sends the cookie and `Origin: <web origin>` and no `Sec-Fetch-Site`. `/api/relay-token` (apps/web/lib/auth/relay-token.ts `isSameOrigin`) falls back to Origin when that header is absent, so no browser header is faked. If the web app starts requiring a real browser (cookie challenge, passkey step), user-plane sign-in here breaks and needs a route made for native clients.
- Import path: `@hawl/client` resolves through hooks in `config/tsconfig.node.json`, `electron.vite.config.ts` (main) and `config/vitest.config.ts` (see FORK-HOOKS.md). The renderer cannot import it (Node only); it talks through the main process.
- No `@hawl/protocol` import at runtime (the fork cannot depend on hawl-platform); types are written here.
- Run against the real relay only on the failure path or the "nothing paused" path: `limits.resume` (a refusal; a real resume needs a work order stopped by the turn cap) and `handoffs.send` with `"auto"` (the relay needs an owner-approved routing rule for the task type, so it answers "No agent can take that kind of work right now"). `channels.thread` and `discussHandoff` have no test of their own.
- `approvals.list` has no cursor and the client cannot add one: the relay returns the 100 OLDEST rows (`ORDER BY id LIMIT 100`, apps/relay/src/policy/approvals.ts). `truncated: true` means newer ones are hidden until older ones are decided; fixing it needs a relay change (hawl-platform, out of scope here). Read `needs.list` for what is new.
- Passkey and OAuth sign-in. Only the emailed-code web sign-in is proven.

## Tests

```
node_modules/.bin/vitest run --config src/hawl/shared/client/vitest.config.ts --maxWorkers=2
node_modules/.bin/tsc -p src/hawl/shared/client/tsconfig.json
node_modules/.bin/oxlint src/hawl
```

The smoke tests in `local-relay.smoke.test.ts` and `local-relay.methods.smoke.test.ts` run by default when a loopback relay (:8080) and web (:3000) answer (`node scripts/local-stack.mjs up` in the hawl-platform e2e worktree), and skip with a warning otherwise. `HAWL_SMOKE_REQUIRE=1` turns a skip into a failure; `HAWL_SMOKE_LOCAL=off` skips on purpose. Non-loopback URLs are refused. They sign in through the real web app (code from the local e2e sink) and the relay's real lookup and approve-device routes; the only SQL is a read-only owner lookup (needs `pg` from `HAWL_PLATFORM_E2E`, default `E:/hawl-platform/.claude/worktrees/e2e`). Test workers leave the site when done. The relay lists at most 500 workers and 100 pending approvals per site, so on a local site that has piled up more than that, the worker-list and held-message smokes cannot find their own row and fail; clean the site, not the client.
