# Upstream merge routine

Orca ships a release every one to two days, so we merge often to keep the fork diff small.

Facts (checked 2026-10-19 in this repo):
- Remote `upstream` is `https://github.com/stablyai/orca.git`, `main` only (`remote.upstream.fetch = +refs/heads/main:refs/remotes/upstream/main`), a blobless partial clone (`remote.upstream.promisor = true`, filter `blob:none`). File contents download on demand.
- Our branch is `hawl/main`. The local `main` branch tracks Orca's main and is never committed to by us.
- Base at fork time: Orca `20fc7af55`. Orca's `package.json` version was `1.4.214` in that tree; the stock installer on the Hawl dev machine is 1.4.229, so the tree is behind the shipped build.

## Weekly routine (do it more often if Orca touched a hook file)

1. Start clean: `git status` shows nothing; you are on a branch made from `hawl/main` (for example `hawl/merge-YYYY-MM-DD`). Never merge straight on `hawl/main`.
2. Fetch: `git fetch upstream main`.
3. See what changed in the files we hook: for each file listed in `FORK-HOOKS.md` run `git diff HEAD...upstream/main -- <file>`. Read those first.
4. Merge: `git merge upstream/main`. Use a merge, not a rebase, so our history stays intact and conflicts show once.
5. Resolve conflicts. Expected conflicts are only in files listed in `FORK-HOOKS.md`. A conflict anywhere else means someone edited an Orca file without a hook entry: fix the code to be a proper hook, add it to `FORK-HOOKS.md`, and note it in the merge commit.
6. Re-check each hook: the line is still in place and its anchor (function or JSX location named in `FORK-HOOKS.md`) still exists. Update line numbers cited in `ARCHITECTURE.md` and `SPEC-MAP.md` if they moved.
7. Check, narrowly: `pnpm install` if the lockfile changed, then `pnpm typecheck` once and the vitest files for `src/hawl/**` (`--maxWorkers=2`). Do not run the full suite locally; CI runs it.
8. Launch: `pnpm dev` with `ORCA_DEV_USER_DATA_PATH` set to a separate folder, confirm the window opens and a terminal spawns with the Hawl env.
9. Commit the merge on its branch, then fast-forward `hawl/main`. Commit message: short and plain, for example `Merge Orca upstream 2026-10-26`.

## Merge rehearsal (milestone M3 proof)

Merge the latest upstream main into a scratch branch and confirm that only files listed in `FORK-HOOKS.md` conflict. Record the result in `PROJECT.md`.

## Rules that keep merges cheap

- New code goes in `src/hawl/`, `hawl-mobile/`, `hawl-plugin/`.
- An edit to an Orca file is one to a few lines, listed in `FORK-HOOKS.md` with file, anchor and purpose.
- Rebrand edits (app id, product name, icons, theme tokens) are hooks too and are listed.
- Do not reformat or move Orca files.
- Orca's lint ratchets scan tracked files; fork code gets exemptions in one config commit, not scattered changes.

## Not decided

- Whether `main` is pushed to a public mirror; no GitHub fork or repository exists yet (`PROJECT.md`).
- How releases track Orca versions (Hawl version numbers are not defined).
