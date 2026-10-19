# Fork hooks

Edits to Orca's own files, one line each. Hawl code itself lives in `src/hawl/`.

Applied by P3-foreman (each is one or two lines, marked `Hawl hook` in the file):

| Piece      | Orca file                                | Edit                                                                                   | Why                                                                                                      |
| ---------- | ---------------------------------------- | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| P3-foreman | `src/main/startup/main-process-ready.ts` | import `startHawlMain` and `await startHawlMain()` after `initializeReadyRuntimeServices()` | Starts the self-hosted foreman. It never throws, so Hawl failing cannot stop the editor starting.        |
| P3-foreman | `src/preload/index.ts`                   | import `hawlForemanApi`; `contextBridge.exposeInMainWorld('hawl', { foreman: hawlForemanApi })` | Gives the app window the foreman calls (and nothing else) as `window.hawl.foreman`.                      |
| P3-foreman | `src/renderer/src/App.tsx`               | import `ForemanDock`; render `<ForemanDock />` after `<RunningTerminalCloseDialog />` | The Foreman button in the corner and the foreman screen it opens.                                        |
| P3-foreman | `config/tsconfig.node.json`              | include `../src/hawl/main/**/*`, `preload`, `shared`                                    | So the main-process typecheck covers Hawl's main and preload code.                                       |
| P3-foreman | `config/tsconfig.web.json`               | include `../src/hawl/renderer/**/*`                                                     | So the renderer typecheck covers the foreman screen.                                                     |

Not applied yet (needs a decision outside this piece):

- Terminal environment. `hawlTerminalEnv(agentId)` in `src/hawl/main/index.ts` returns `HAWL_FOREMAN_URL`,
  `HAWL_FOREMAN_TOKEN` and `HAWL_AGENT_ID` for a terminal. It is meant to be called from `buildPtyHostEnv`
  (`src/main/ipc/pty/host-env/assembly.ts`) so every Orca terminal becomes an agent of the yard. Which id a terminal
  uses as its agent id is the terminal piece's call, so the hook is not in yet; until then an agent gets the three
  values from `window.hawl`-free means (the dev script below) or by hand.
- The Dispatcher link. `startHawlForeman` returns `fromDispatcher(event, { requester, preferAgent })` and takes the
  signed-in connection through its `relay` option. Wiring the sign-in (P2) and the site event stream to those two
  seams is the next piece's job.

How to try it without a relay: write `<userData>/hawl/foreman-identity.json`
(`{"yard","owner","displayName","yardId":"vil_..","siteId":"twn_.."}`), start the app with `HAWL_FOREMAN_DEV=1`, and
`window.hawl.foreman.devOffer("hnd_1", "fix-bug")` makes a job as the Dispatcher would.
