# Hawl Workstation: ARCHITECTURE

Status 2026-10-19: design only. Nothing in `src/hawl/` exists yet. Every claim about Orca's code is tagged with `file:line` read on branch `hawl/P4-docs` (base `hawl/main` 3fd6f54a4, Orca upstream `20fc7af55`). A claim tagged **(unverified)** was not confirmed in code. Claims about the Hawl relay come from `m2-contract.md` (a contract, not shipped code) and are tagged **(contract)**.

Sources: `PROJECT.md`, the plan (`i-want-to-sort-goofy-treasure.md`), the m2 contract (`E:\hawl-platform\_work\2026-10-18-scenarios\m2-contract.md`, S4 to S50). The per-line plan is in `SPEC-MAP.md`.

## 1. Shape of the fork

Thin fork of Orca (MIT, stablyai/orca), credited openly. Orca stays the shell: Electron main process, React renderer (Zustand store), node-pty terminals, git worktrees, the loopback agent-hook server, the plugin host, the mobile companion and its relay client.

Rules:
- All Hawl code lives in `src/hawl/` (main, renderer, shared), `hawl-mobile/` and `hawl-plugin/`.
- Edits to Orca files are small hooks. Each hook is one line in `FORK-HOOKS.md` (file, purpose, how to re-check after a merge). `FORK-HOOKS.md` does not exist yet: the first hook commit creates it.
- Hawl never edits relay or CLI files that belong to the m2 builders. The workstation codes to the contract schemas (`packages/gateway-contract`, `packages/protocol` in the hawl-platform repo).

## 2. Layout

```
src/hawl/
  shared/      types and zod schemas for relay payloads (site, yard, station, job, card, ledger, menu, approval)
  client/      @hawl/client: relay HTTP + WebSocket client, auth, token storage, reconnect, event replay
  main/        main-process services: auth, per-terminal Hawl env, event hub, foreman host, daemon bridge, IPC handlers
  renderer/    React: site switcher, yard tree, terminal strip, job drawer, yard console, approvals, map, list view
  theme/       Hawl tokens (from packages/ui/tokens.css), icons, art
hawl-plugin/   Orca plugin (orca-plugin.json) for panels that fit the plugin host; see section 8
hawl-mobile/   Hawl-native phone app (starts from Orca's mobile/ Expo app); see section 10
```

`src/hawl/` is new code, so the lint ratchets that scan `git ls-files` (`package.json` `lint` script) need exemptions in one config commit (plan, "Shape"). Not yet checked which ratchets fire on new files: **(unverified)**.

## 3. Shell (what Orca already is)

| Part | Where | Verified |
|---|---|---|
| Main entry | `electron.vite.config.ts`; built to `out/main/index.js` (`package.json` `main`) | yes |
| Window title and frame | `src/main/window/createMainWindow.ts:108` (`title: opts?.title ?? 'Orca'`) | yes |
| App id, product name, protocol, update feed | `config/electron-builder.config.cjs:112` (`appId`), `:242` (`productName`), `:243` (`protocols`), `:802-805` (`publish` github owner/repo) | yes |
| Theme tokens | `src/renderer/src/assets/main.css:197` (`--background` light), `:298` (`.dark`), font at `:13` (Geist) | yes |
| Terminal palettes | `src/shared/terminal-themes/` | dir exists; contents not read |
| Telemetry | `src/main/telemetry/client.ts:31` (write key only from build-time define), `:111` (`host: 'https://us.i.posthog.com'`). The file comment at `:182-183` says contributor and non-official builds do not transmit | yes (comment); network capture is the M0 proof |
| Data model | `src/shared/repo-types.ts:53` (`Repo`), `src/shared/worktree/types.ts:100` (`Worktree`), `src/shared/project-group-types.ts:1` (`ProjectGroup`) | yes |
| Store | `src/renderer/src/store/slices/` (one slice per concern, e.g. `agent-status.ts`) | yes |
| Dev userData | `config/scripts/run-electron-vite-dev.mjs:434-451`: `pnpm dev` uses `%APPDATA%\orca-dev`, override with `ORCA_DEV_USER_DATA_PATH` | yes |

## 4. Seam: Hawl env into every terminal

One terminal = one agent in the owner's yard (plan, "Yard-native projects"). The agent picks its identity from env at spawn: the Hawl CLI resolves `HAWL_RESIDENT_ID`, then `HAWL_SITE`, then the folder id file (plan, "Terminal seams", from `packages/cli/src/.../resolve.ts:91-127` in hawl-platform; not re-read here **(unverified in this pass)**).

Orca spawn path, read in this pass:
1. Renderer calls IPC `pty:spawn`. Handler: `src/main/ipc/pty/ipc/spawn.ts:10-19` (`ipcMain.handle('pty:spawn', ...)` then `runPtyIpcSpawn`).
2. Two lanes assemble the env, both by calling the same function:
   - window lane: `src/main/ipc/pty/provider/local-configure.ts:79` (`buildPtyHostEnv(id, baseEnv, {...})`)
   - host-spawn lane: `src/main/ipc/pty/spawn-host-env.ts:214` (`buildPtyHostEnv(sessionId, env, {...})`)
3. `buildPtyHostEnv` is `src/main/ipc/pty/host-env/assembly.ts:44`. It mutates `baseEnv` in place and returns it at `:322`. Its doc comment (`:38-42`) says do NOT call it for SSH (`args.connectionId` set): injections are host-loopback or local paths.
4. Pane identity is stamped separately: `src/main/ipc/pty/spawn-pane-env.ts:57` (`env.ORCA_PANE_KEY = pane.paneKey`), `:64` (`ORCA_WORKTREE_ID`).
5. Hook coordinates: `assembly.ts:128-132` first deletes inherited `ORCA_AGENT_HOOK_*` keys (list in `src/main/ipc/pty/host-env/spawn-env-keys.ts:4-12`), then `Object.assign(baseEnv, agentHookServer.buildPtyEnv())`. `buildPtyEnv` is `src/main/agent-hooks/server/server-runtime-env.ts:13-22`: it sets `ORCA_AGENT_HOOK_PORT`, `ORCA_AGENT_HOOK_TOKEN`, `ORCA_AGENT_HOOK_ENV`, `ORCA_AGENT_HOOK_VERSION`. This answers the plan's open question: the loopback endpoint and token reach external processes through the pty env at spawn.

Hawl hook (one line in `FORK-HOOKS.md`): at the end of `buildPtyHostEnv`, before `return baseEnv` (`assembly.ts:322`), call `applyHawlTerminalEnv(id, baseEnv, opts)` from `src/hawl/main/terminal-env.ts`. It sets, per terminal: `HAWL_SITE` (active site), `HAWL_RESIDENT_ID` (this terminal's agent), plus a Hawl event socket path. It must skip SSH (same rule as step 3).

Limits found:
- SSH terminals skip `buildPtyHostEnv`, so Hawl env does not reach them by this seam. How Hawl works over SSH is not designed **(unverified)**.
- The daemon lane re-strips some keys: the plan says so; `src/main/daemon/pty-subprocess-env-inheritance.test.ts:608` references the Windows PATH collapse. Which keys the daemon strips was not read **(unverified)**. M3 must test that `HAWL_*` survives the daemon.
- A second hook (a per-terminal agent registration at spawn) is not yet designed; it hangs off `pty:spawn` (`spawn.ts:10`).

## 5. Seam: terminal pane header (foreman strip and state)

- Header component: `src/renderer/src/components/terminal-pane/TerminalPaneHeaderOverlay.tsx:64` (default export, props at `:64-102` include `tabId`, `worktreeId`, `panes`, `paneTitles`). It is mounted at `src/renderer/src/components/terminal-pane/TerminalPaneSurface.tsx:338`.
- Tab: `src/renderer/src/components/tab-bar/TerminalSortableTab.tsx:8` (wraps `SortableTab` with `useTabAgent`).
- Hawl hook: render `<HawlPaneChip paneKey=... />` from `src/hawl/renderer/` inside the header overlay. One import and one JSX line in `TerminalPaneHeaderOverlay.tsx`. The chip shows site, agent handle, state, work card title, claim/lease (S16, S17, S23, S24). Live events appear in a strip in the pane chrome, never typed into the pty text (plan).
- Agent state already available to the renderer: store slice `src/renderer/src/store/slices/agent-status.ts` and the event schema `src/shared/plugins/plugin-events.ts:28-48` (`agent.status.changed`: `worktreeId`, `paneKey`, `state`, `mainAgent`). The Hawl chip joins on `paneKey`.
- Agent status transport: managed hooks POST to the loopback hook server, OSC 7501 fills gaps; hooks win (`src/main/agent-hooks/README.md:3-20`). Claude hooks are installed as managed entries in Claude's `settings.json` by `src/main/claude/hook-service.ts:167,187` (`install` -> `applyManagedHooks`). Hawl's own Claude hook entries must stay distinct from Orca's managed ones; the managed marker logic is `applyManagedHooks` (`claude-managed-hook-events.ts`, not read in full **(unverified)**).
- `src/main/agent-awake-service.ts:45` (`AgentAwakeService`) manages computer awake mode (power-save blocker, `:30-43`). It is not the Hawl wake mechanism (plan).

## 6. Seam: sidebar

- Sidebar root: `src/renderer/src/components/sidebar/index.tsx`. Children in order: `<SidebarNav />` (`:174`), `<SidebarHeader ...>` (`:175`), `<WorktreeList ...>` (`:199`). `SidebarAgentsList` is lazy (`:27`).
- Plan: site switcher above the tree, then "<Name>'s yard", then each project folder as a station, then its terminals/agents (S4, S5). Orca's tree is Repo -> Worktree (`Repo` `repo-types.ts:53`, `Worktree` `worktree/types.ts:100`). A Hawl station maps to an Orca `Repo` folder; a terminal/agent maps to a pane inside a `Worktree`.
- Hawl hook: render `<HawlSiteSwitcher />` and a yard header above `<WorktreeList>` and let `WorktreeList` row components accept a Hawl decoration slot. Exact insertion points are decided in M2; nothing about `WorktreeList` internals was read **(unverified)**.

## 7. Seam: relay events, mapping, state

The workstation is its own relay client (plan, "Terminal seams"):
- `@hawl/client` (in `src/hawl/client/`) opens `/v1/ws` and `/v1/towns/:twn/events` on `relay.hawl.ai` (routes per plan and contract; `/v1/ws` and the events route exist in the hawl-platform relay per the plan; contract routes for yards, ledger, jobs, asks, approvals are **(contract)** and not on origin/main as of 2026-10-19 per the plan).
- Auth: device-code login at hawl.ai/device, then an EdDSA assertion to `POST /v1/auth/token` (plan; from `packages/cli/src/commands/join.ts`). Token goes to the OS keyring (M1). Orca has its own profile cloud sign-in (`src/main/orca-profiles/profile-cloud-*.ts`, e.g. `profile-cloud-service.ts`, `profile-cloud-pkce.ts`); its backend host was not read **(unverified)**, and Hawl sign-in replaces or sits beside it (decide in M1).
- The Hawl daemon (`~/.hawl/daemon.sock`, token in `~/.hawl/daemon.token`) is request/response with no event subscription (plan). The workstation uses it for local state, mailbox and tool calls, not for live events.
- Event hub: `src/hawl/main/event-hub.ts` fans relay events to renderer windows over one IPC channel and to the foreman host. Renderer state lives in a new Zustand slice `src/hawl/renderer/store/hawl-slice.ts`, registered in the app store with one hook line.

## 8. Plugin host

Orca has an out-of-process plugin host (`src/main/plugins/`, `src/shared/plugins/`).
- Manifest (zod): `src/shared/plugins/plugin-manifest.ts:96-121` (`contributes.panels|commands|events|languagePacks|keybindings|vmRecipes|agents`, `capabilities`, `pluginApi: 1`). File name `orca-plugin.json` (from the plan; the manifest-file reader `src/main/plugins/plugin-manifest-file.ts` was not opened **(unverified)**).
- Panels render in a sandboxed iframe in the right-sidebar activity bar only (`plugin-manifest.ts:44-51`; renderer `components/right-sidebar/PluginPanel.tsx`).
- Events a plugin can subscribe to: `worktree.created`, `worktree.removed`, `agent.status.changed` (`plugin-events.ts:50-54`, payload schemas).
- Experimental, no stability promise: `src/shared/plugins/plugin-host-api.ts` header (read).
- Official-publisher gate: `src/shared/plugins/plugin-marketplace.ts:9-12` (`OFFICIAL_PLUGIN_PUBLISHER = 'stablyai'`, id prefix `orca-`, marketplace repo `stablyai/orca-plugins`). Bundled plugins must pass that gate, so the fork changes these constants or loads `hawl-plugin/` as a dev/local plugin. Choice made in M2.

Use: `hawl-plugin/` holds only what fits a right-sidebar panel (for example ledger list, doctor output). The tree, pane header, job drawer and yard console are native `src/hawl/renderer/` code, because panels cannot draw in the sidebar tree or terminal header.

## 9. Foreman

Decision (Aaron 2026-10-19, `PROJECT.md`): the foreman is a registered agent. The yard owner registers one of their own agents as the foreman (a role on an agent, not a separate service). The Workstation alerts when a yard has no foreman or its foreman is offline, and guides setup: pick an agent, confirm menu and hold times, test with the team check (S43), and `hawl doctor` (S44) names "no foreman" or "foreman offline". The relay answering service (accept and queue per the published menu when the foreman is offline, S15) is a relay piece owned by the m2 builders, not by this fork.

Workstation parts, in `src/hawl/main/foreman/` and `src/hawl/renderer/yard/`:
- Foreman registration: pick agent, set role, show state "no foreman / offline / online".
- Menu editor and publish (S11, S12), hold and release times (S18), auto-accept (S15), foreman rules (S20).
- Intake and routing to inner agents of the yard follow the contract's job states: queued, offered, running, held (**contract**, section 4 "Foreman design"). In this design the registered agent executes the loop; the workstation supplies the UI, the registration, and the alerts. Whether the loop logic ships as a Hawl skill/MCP tool or as workstation main-process code is the P3-foreman piece's decision; this document does not decide it.

## 10. Phone

- Orca's phone path (read): Expo app in `mobile/` (`mobile/README.md`), desktop WebSocket RPC server on port 6768 (`mobile/README.md:7`; server code `src/main/runtime/rpc/ws-transport.ts:1-3`), cloud relay client `src/main/runtime/mobile-cloud-relay/` (`desktop-relay-service.ts:45`), cloud relay and push services in `cloud/apps/{push,relay,relay-fence-broker,relay-ops}` (GCP-specific per the plan).
- Hawl phone (M6): `hawl-mobile/` starts from `mobile/`, replaces the pairing relay and push with Hawl's relay and Hawl's own push. Approvals and ask_human answers (S39, S40) go to the phone through Hawl's relay, not through Orca's cloud. Mobile distribution and signing are open (`PROJECT.md`).

## 11. Visualizations (map, list)

Map (S45 to S47): the Dispatcher hub, factories, crates. Designs and art come from `E:\hawl-platform\_work\2026-10-12-cd-full` and the web factory scene planned in the contract (X1 to X5). In the workstation the map is a renderer panel in `src/hawl/renderer/map/` that renders a pure scene model from the ledger. The plain list view (same data) is the default on phones and when WebGL is unavailable (S47). Whether Orca's renderer already ships a WebGL context to reuse for non-terminal scenes was not checked **(unverified)**.

## 12. Hooks in Orca files (expected set, each one line in FORK-HOOKS.md)

| # | Orca file | Purpose |
|---|---|---|
| 1 | `src/main/ipc/pty/host-env/assembly.ts` (before `:322`) | inject Hawl env per terminal |
| 2 | `src/renderer/src/components/terminal-pane/TerminalPaneHeaderOverlay.tsx` | Hawl chip and foreman strip |
| 3 | `src/renderer/src/components/sidebar/index.tsx` | site switcher and yard header |
| 4 | main-process bootstrap (file not yet chosen) | start `src/hawl/main` services |
| 5 | renderer store root | register the Hawl slice |
| 6 | `config/electron-builder.config.cjs` (`:112`, `:242`, `:243`, `:804`) | id, name, protocol, update feed (M0 rebrand) |
| 7 | `src/main/window/createMainWindow.ts:108` | window title |
| 8 | `src/renderer/src/assets/main.css` (`:197`, `:298`) | import Hawl tokens |
| 9 | `src/shared/plugins/plugin-marketplace.ts:9-12` | publisher and id prefix |
| 10 | `.oxlintrc.json` and `config/scripts/*` ratchets | exemptions for `src/hawl/**` |

Hooks 4 and 5 name no file yet because the main bootstrap and the store root were not located in this pass.

## 13. What is NOT verified

- Nothing in `src/hawl/` has been built or run. This is a design document.
- The Hawl relay routes for yards, ledger, jobs, asks, approvals and the foreman do not exist on hawl-platform origin/main as of 2026-10-19 (plan). They are contract only.
- Daemon env stripping, SSH behavior, `WorktreeList` internals, the profile sign-in backend, plugin API stability, lint ratchets on new files.
- Launch time and terminal latency against stock Orca are measured by P0-bench, not here.
