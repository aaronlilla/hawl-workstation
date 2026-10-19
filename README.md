# Hawl Workstation

The free, open-source desktop workstation for [Hawl](https://hawl.ai): an agentic IDE where you start and run whole projects, with sites, yards, jobs, approvals, rooms and presence built in, and Hawl sign-in.

Status 2026-10-19: early. This repository is a thin fork of Orca with design and planning documents added. The Hawl features are not built yet. Everything below about running the app describes stock Orca behavior in this fork, except where it says otherwise.

## Built on Orca

Hawl Workstation is built on [Orca](https://github.com/stablyai/orca) by Stably AI / Lovecast Inc., released under the MIT license. We do not hide that. Orca provides the shell: terminals, git worktrees, the agent-status hooks, the plugin host and the mobile companion. Hawl adds its own features, theme, graphics and icons on top, kept in `src/hawl/`, `hawl-mobile/` and `hawl-plugin/`. Edits to Orca's own files are small hooks, each listed in `FORK-HOOKS.md` (created with the first hook).

Orca's original copyright and license stay in [LICENSE](LICENSE). The weekly routine for pulling Orca's changes is in [UPSTREAM.md](UPSTREAM.md).

## Where things are

| Document | What it holds |
|---|---|
| [PROJECT.md](PROJECT.md) | What this is, status, decisions |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Shell, layout of `src/hawl/`, the seams in Orca's code, relay events, foreman, phone |
| [SPEC-MAP.md](SPEC-MAP.md) | Every Hawl behavior line (S4 to S50): which screen shows it, where the data comes from, how it is proven |
| [UPSTREAM.md](UPSTREAM.md) | Merging Orca's updates |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Working in this fork |

## Run it from source (Windows, macOS, Linux)

Checked 2026-10-19 on Windows Server 2025: Node v24.20.0 and pnpm 12.14.0 were installed, and `pnpm dev` built the main process and preload, started the renderer dev server, and opened the Electron window (window title "Orca" at this stage, since the rebrand is not done). Not checked: a clean `pnpm install` from scratch, `pnpm test` (it needs Bun, which was not installed on that machine), any macOS or Linux run.

1. Install Node 24 and pnpm. The Bun version in [config/.bun-version](config/.bun-version) is needed only for `pnpm test`. Details: [.github/CONTRIBUTING.md](.github/CONTRIBUTING.md), "Local Setup".
2. In the repository folder run `pnpm install`.
3. Run `pnpm dev`. It starts the app with its own user-data folder (`%APPDATA%\orca-dev` on Windows, per `config/scripts/run-electron-vite-dev.mjs:434-451`).
4. To keep a dev copy away from an installed Orca or another dev copy, set `ORCA_DEV_USER_DATA_PATH` to a separate folder first. In PowerShell: `$env:ORCA_DEV_USER_DATA_PATH='C:\dev\my-userdata'`. Never run two copies on the same user-data folder.

Other commands (from `package.json`): `pnpm build:win` packages a Windows installer, `pnpm typecheck` type-checks all projects, `pnpm lint` runs the lint gates.

## License

MIT, see [LICENSE](LICENSE).
