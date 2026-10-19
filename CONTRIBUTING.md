# Contributing to Hawl Workstation

This is a thin fork of Orca. Orca's own contribution rules still apply to anything that touches Orca code: read [.github/CONTRIBUTING.md](.github/CONTRIBUTING.md) and [docs/STYLEGUIDE.md](docs/STYLEGUIDE.md) first.

## Where code goes

- Hawl code: `src/hawl/` (main, renderer, shared, client, theme), `hawl-mobile/`, `hawl-plugin/`.
- Orca files: edit only for a small hook. Add a line to `FORK-HOOKS.md` (file, anchor, purpose) in the same commit. Keep the diff to a few lines so upstream merges stay cheap. See [UPSTREAM.md](UPSTREAM.md).
- Documents: [ARCHITECTURE.md](ARCHITECTURE.md) says how the pieces fit, [SPEC-MAP.md](SPEC-MAP.md) lists every behavior line (S4 to S50) with its screen and proof.

## Working

1. Make a branch from `hawl/main` (or a git worktree: `git worktree add <path> -b hawl/<name> hawl/main`). Do not commit to `main`; it follows Orca.
2. Build what is in `SPEC-MAP.md`. When a line is shown and proven in the running app, change its status from `todo` and paste how it was proven.
3. Run only what you touched: `pnpm exec vitest run --config config/vitest.config.ts <files> --maxWorkers=2`. Full lint, full typecheck and the full suite run once at the end or in CI.
4. Use a separate user-data folder when you run the app (`ORCA_DEV_USER_DATA_PATH`), never the same as an installed Orca.
5. Commit with a short plain message. Do not add AI credit lines.

## Credit

Keep the "Built on Orca" notice in the README and the About screen, and keep [LICENSE](LICENSE) intact.
