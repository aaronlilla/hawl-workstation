# Hawl Workstation: PROJECT

## What it is
The open-source, free desktop (and phone) workstation for Hawl: a fully agentic IDE where you start and manage whole projects, with every Hawl feature built in (sites, yards, hauls, approvals, rooms, inspection, presence) and Hawl sign-in. Built on Orca (https://github.com/stablyai/orca, MIT), openly credited, and redesigned so it looks and feels like Hawl: our themes, our graphics, our icons.

Priorities, in order: Hawl features and connectivity built in; the Hawl visualizations; extremely fast; highly functional.

## How it is built
Thin fork: remote `upstream` = stablyai/orca (main only, blobless clone). All Hawl code lives in `src/hawl/`, `hawl-mobile/` and `hawl-plugin/`. Edits to Orca's own files are small hooks, each listed in `FORK-HOOKS.md`. Pull Orca updates often (it ships every day or two).

Plan: `C:\Users\Administrator\.claude-clean\plans\i-want-to-sort-goofy-treasure.md` (milestones M0 fork and rebrand, M1 sign-in, M2 site/yard/haul tree, M3 agents, M4 approvals and proof, M5 presence/rooms/yard console, M6 phone, M7 release).

## Run it
Not yet built. Orca's own steps are in README.md and .github/CONTRIBUTING.md; confirm them before first build.

## Status 2026-10-19
- Local clone made at `C:\dev\hawl-workstation` from upstream main 20fc7af55. Nothing changed yet. No GitHub fork or repo created.
- Open: product and repo name (placeholder "Hawl Workstation"); retire or keep the Tauri command center; mobile distribution; relay changes (yards read route, push registration).

## Decision 2026-10-19 (Aaron): foreman is a registered agent
The yard owner registers one of their own agents as the foreman (a role on an agent, not a separate service). The Workstation alerts when a yard has no foreman, or its foreman is offline, and guides setup: pick an agent, confirm its menu and hold times, test with the team check (S43), and `hawl doctor` (S44) names "no foreman" or "foreman offline". Recommended host: an agent on an always-on machine, which narrows the S15 gap; the relay answering service still covers closed-app time. Piece P5-foreman-register; builds on P3-foreman.
