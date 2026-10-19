# Upstream merge routine

Orca ships often (GitHub releases, `gh api repos/stablyai/orca/releases`, read 2026-10-19: v1.4.224 on 2026-10-10, v1.4.227 on 10-16, v1.4.229 on 10-17, v1.4.230 on 10-19), so we merge often to keep the fork diff small.

Facts (checked 2026-10-19 in this repo):
- Remote `upstream` is `https://github.com/stablyai/orca.git`, `main` only (`remote.upstream.fetch = +refs/heads/main:refs/remotes/upstream/main`), a blobless partial clone (`remote.upstream.promisor = true`, filter `blob:none`). File contents download on demand.
- Our branch is `hawl/main`. The local `main` branch tracks Orca's main and is never committed to by us.
- Base at fork time: Orca `20fc7af55` (`upstream/main` was `575d3b2cf` on 2026-10-19). Orca's `package.json` version was `1.4.214` in that tree; the stock installer on the Hawl dev machine is 1.4.229, so the tree is behind the shipped build.

## Weekly routine (do it more often if Orca touched a hook file)

1. Start clean: `git status` shows nothing; you are on a branch made from `hawl/main` (for example `hawl/merge-YYYY-MM-DD`). Never merge straight on `hawl/main`.
2. Fetch: `git fetch upstream main`.
3. See what changed in the files we hook: for each file named in [FORK-HOOKS.md](FORK-HOOKS.md) run `git diff HEAD...upstream/main -- <file>`. Read those first. Quick filter: `git diff --name-only HEAD...upstream/main` and look for the hook files.
4. Merge: `git merge upstream/main`. Use a merge, not a rebase, so our history stays intact and conflicts show once.
5. Resolve conflicts. Expected conflicts are only in files listed in `FORK-HOOKS.md`. A conflict anywhere else means someone edited an Orca file without a hook entry (`README.md` is hook row 12: keep ours): fix the code to be a proper hook, add it to `FORK-HOOKS.md`, and note it in the merge commit.
6. Re-check each hook: the line is still in place and its anchor (literal text in `FORK-HOOKS.md`) still exists. Run `node hawl-tools/check-docs.mjs`: it fails on a missing anchor, a missing cited file or a cited line past the end of a file. Then fix by hand any cited line number that moved or whose text changed (the script cannot see that).
7. Check, narrowly: `pnpm install` if the lockfile changed, then `pnpm typecheck` once and the vitest files for `src/hawl/**` (`--maxWorkers=2`). Do not run the full suite locally; CI runs it.
8. Launch: `pnpm dev` with `ORCA_DEV_USER_DATA_PATH` set to a separate folder, confirm the window opens and a terminal spawns with the Hawl env.
9. Commit the merge on its branch, then fast-forward `hawl/main`. Commit message: short and plain, for example `Merge Orca upstream 2026-10-26`.

## Merge rehearsal

Run once on 2026-10-19 on branch `hawl/P4-docs` (docs only so far, so it is a rehearsal of steps 2 and 3 and of the conflict check, not of a hooked tree):
- `git fetch upstream main` moved `upstream/main` from `20fc7af55` to `575d3b2cf`: 33 commits ahead, 795 files changed.
- Step 3: of the Orca files named in rows 1 to 9 of FORK-HOOKS.md, one changed upstream: `src/renderer/src/components/terminal-pane/TerminalPaneHeaderOverlay.tsx` (1 line). Its anchor `export default function TerminalPaneHeaderOverlay(` is still there. The anchors of rows 1 to 5 and 7 to 9, and `productName` for row 6, were found on `upstream/main` too (`git show upstream/main:<file>`, literal text count, each 1 or more); row 6's `appId`, `protocols` and `publish` were not re-checked there.
- Step 4 dry run: `git merge-tree --write-tree HEAD upstream/main` printed a tree id and no conflicts. Our tree rewrites `README.md` (now FORK-HOOKS row 12), and Orca did not change `README.md` or `docs/readme` in those 33 commits (`git diff --stat HEAD...upstream/main -- README.md` printed nothing), so no conflict showed. The first time Orca edits its README the merge will conflict there; the rule is keep ours. The real merge was not done and `hawl/P4-docs` was not changed.
- Rows 11 and 12 were added after this rehearsal; row 11's anchor `createGpuAccelerationAboutPanelOptions` is in `upstream/main` (`git show upstream/main:src/main/menu/gpu-acceleration-about-panel.ts`).
- Not rehearsed: steps 5 to 9 on a tree with hooks applied. There are no hooks yet. Repeat this rehearsal in the first milestone that applies a hook (M0 rebrand edits rows 6 to 8) and record the result in `PROJECT.md`.

## Rules that keep merges cheap

- New code goes in `src/hawl/`, `hawl-mobile/`, `hawl-plugin/`.
- An edit to an Orca file is one to a few lines, listed in `FORK-HOOKS.md` with file, anchor and purpose.
- Rebrand edits (app id, product name, icons, theme tokens) are hooks too and are listed.
- Do not reformat or move Orca files.
- Orca's lint ratchets scan tracked files; fork code gets exemptions in one config commit, not scattered changes.

## Not decided

- Whether `main` is pushed to a public mirror; no GitHub fork or repository exists yet (`PROJECT.md`).
- How releases track Orca versions (Hawl version numbers are not defined).
