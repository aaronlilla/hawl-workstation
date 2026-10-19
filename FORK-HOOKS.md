# Fork hooks

Every edit Hawl makes to an Orca file is one row here. A row says which file, what string in that file marks the spot (the anchor), and what the edit does. Rule: no Orca file is edited without a row (see [UPSTREAM.md](UPSTREAM.md) step 5 and `hawl-tools/check-docs.mjs`, which fails if an anchor is missing).

Status 2026-10-19: no hook is applied yet. Every row is `planned`. The files and anchors below were read on Orca `20fc7af55` (this branch's base) and anchors of rows 1 to 5 and 7 to 9 (and `productName` of row 6) were re-checked against `upstream/main` `575d3b2cf` (33 commits ahead): all files exist there, and only `TerminalPaneHeaderOverlay.tsx` changed, by one line that does not touch the anchor. The first hook commit changes a row's status to `applied` and fills in the commit.

| # | Orca file | Anchor (literal text that must still be in the file) | Edit | Milestone | Status |
|---|---|---|---|---|---|
| 1 | `src/main/ipc/pty/host-env/assembly.ts` | `export function buildPtyHostEnv(` and the final `return baseEnv` of that function | Call `applyHawlTerminalEnv(id, baseEnv, opts)` just before the last `return baseEnv`. Sets `HAWL_SITE`, `HAWL_PANE_KEY` and (only when known) `HAWL_RESIDENT_ID`. See ARCHITECTURE section 4 | M3 | planned |
| 2 | `src/renderer/src/components/terminal-pane/TerminalPaneHeaderOverlay.tsx` | `export default function TerminalPaneHeaderOverlay(` | One import and one `<HawlPaneChip paneKey=... />` in the overlay's pane-title row | M3 | planned |
| 3 | `src/renderer/src/components/sidebar/index.tsx` | `<WorktreeList` | Render `<HawlSidebarTree />` (site switcher and yard header) above the `<WorktreeList` element in the worktree body. The `sidebarBody === 'agents'` branch (`SidebarAgentsList`) is left alone at first | M2 | planned |
| 4 | `src/main/startup/main-process-ready.ts` | `await initializeReadyRuntimeServices()` | After that line, `await startHawlMain()` (starts auth, event hub, IPC handlers from `src/hawl/main`). This is the ready-phase composition called from `src/main/index.ts` (`initializeMainProcessReady`) | M1 | planned |
| 5 | `src/renderer/src/store/index.ts` | `...createWorkspaceAttentionSlice(...a)` | Add `...createHawlSlice(...a)` after the last slice in the object returned by `create<AppState>()`. Also needs the `AppState` type in `src/renderer/src/store/types.ts` to include the Hawl slice type (second small edit, same hook) | M2 | planned |
| 6 | `config/electron-builder.config.cjs` | `appId`, `productName`, `protocols`, `publish` | App id, product name, protocol scheme, update feed (rebrand) | M0 | planned |
| 7 | `src/main/window/createMainWindow.ts` | `title: opts?.title ?? 'Orca'` | Window title "Hawl" | M0 | planned |
| 8 | `src/renderer/src/assets/main.css` | `--background` | Import Hawl tokens after Orca's | M0 | planned |
| 9 | `src/shared/plugins/plugin-marketplace.ts` | `OFFICIAL_PLUGIN_PUBLISHER` | Publisher and id prefix, only if `hawl-plugin/` ships as a bundled plugin (otherwise it is loaded as a local plugin and this row is dropped). Decided in M2 | M2 | planned |
| 10 | `.oxlintrc.json` and the ratchet scripts under `config/scripts/` that read `git ls-files` | exact files chosen in the config commit | Exempt `src/hawl/**`, `hawl-mobile/**`, `hawl-plugin/**`, `hawl-tools/**` from Orca-only ratchets. Which ratchets fire on new files is not yet checked | M0 | planned |

Notes
- Hook 1 is reached by the two callers of `buildPtyHostEnv` (`src/main/ipc/pty/provider/local-configure.ts:79` and `src/main/ipc/pty/spawn-host-env.ts:214`); the single edit inside the function covers both. Agent sessions started through the structured-session lane (`src/main/runtime/structured-session-child-env.ts`) reuse parts of the same logic without calling `buildPtyHostEnv`; whether they need a Hawl hook is not checked.
- Line numbers are deliberately not in this file. Anchors are literal text, which `hawl-tools/check-docs.mjs` can check.
