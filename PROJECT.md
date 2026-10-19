# Hawl Workstation: PROJECT

## What it is
The open-source, free desktop (and phone) workstation for Hawl: a fully agentic IDE where you start and manage whole projects, with every Hawl feature built in (sites, yards, hauls, approvals, rooms, inspection, presence) and Hawl sign-in. Built on Orca (https://github.com/stablyai/orca, MIT), openly credited, and redesigned so it looks and feels like Hawl: our themes, our graphics, our icons.

Priorities, in order: Hawl features and connectivity built in; the Hawl visualizations; extremely fast; highly functional.

## How it is built
Thin fork: remote `upstream` = stablyai/orca (main only, blobless clone). All Hawl code lives in `src/hawl/`, `hawl-mobile/` and `hawl-plugin/`. Edits to Orca's own files are small hooks, each listed in `FORK-HOOKS.md`. Pull Orca updates often (it ships every day or two).

Plan: `C:\Users\Administrator\.claude-clean\plans\i-want-to-sort-goofy-treasure.md` (milestones M0 fork and rebrand, M1 sign-in, M2 site/yard/haul tree, M3 agents, M4 approvals and proof, M5 presence/rooms/yard console, M6 phone, M7 release).

## Run it
From a checkout: `pnpm install --frozen-lockfile`, `pnpm run build:electron-vite`, then `node_modules/electron/dist/electron.exe .` (add `--remote-debugging-port=9333` to drive it). Unit tests: `node node_modules/vitest/vitest.mjs run --config config/vitest.config.ts --maxWorkers=2 <paths>` (the `run-vitest.mjs` wrapper needs Bun, which is not installed). Network proof: `node src/hawl/tools/net-capture.mjs 130 out.json`. Every edited Orca file is listed in FORK-HOOKS.md.

## Status 2026-10-19
- Local clone made at `C:\dev\hawl-workstation` from upstream main 20fc7af55. Nothing changed yet. No GitHub fork or repo created.
- Open: product and repo name (placeholder "Hawl Workstation"); retire or keep the Tauri command center; mobile distribution; relay changes (yards read route, push registration).

- 2026-10-19 P1-rebrand (M0): rebranded on branch `hawl/P1-rebrand`: identity, Hawl theme and terminal palettes, icons, About credit, updater feed, vendor services and telemetry off. See FORK-HOOKS.md.

- 2026-10-19 P1-rebrand round 2: critic fixes (logo colour, Inter default font, light default, own profile folder, hawl:// parsing, telemetry code deleted, vendor feeds removed, Orca account pane hidden, version 0.1.0). Leftovers in FORK-HOOKS.md.
