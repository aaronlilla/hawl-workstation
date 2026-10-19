# FORK-HOOKS

Every Orca file this fork edits. After each upstream merge, re-check exactly these files. All Hawl code lives in `src/hawl/`; Orca files only get the small hooks below. Last updated at piece P1-rebrand (M0).

Switches in `src/hawl/shared/brand.ts`: `HAWL_VENDOR_SERVICES_ENABLED = false` (Orca hosted services off), `rebrandText()` and the `hawl-brand` i18next post-processor (whole-word "Orca" becomes "Hawl" in UI copy without touching any catalog).

## Build and packaging
| File | Hook |
|---|---|
| `config/electron-builder.config.cjs` | appId `com.hawl.workstation`, productName, `hawl` protocol scheme, maintainer, publish owner/repo (`aaronlilla/hawl-workstation`), dev-channel repo names. Artifact names, CLI binary names (`orca`, `orca-ide`) and NSIS files unchanged. |
| `config/dev-app-update.yml` | update feed owner `aaronlilla` |
| `package.json` | description, homepage, author (name stays `orca`) |
| `src/shared/release-channel.ts` | release repos point at `aaronlilla/hawl-workstation*` |
| `src/main/updater/updater-setup.ts`, `src/main/updater/updater-release-feed.ts`, `src/main/updater-prerelease-feed.ts` | GitHub feed URLs and regexes point at our repo |

## Identity and window
| File | Hook |
|---|---|
| `src/main/startup/dev-instance-identity.ts` | app name and AppUserModelId from `brand.ts` |
| `src/main/window/createMainWindow.ts` | default window title |
| `src/renderer/index.html`, `popout.html`, `space.html`, `web-index.html` | `<title>` |
| `src/main/i18n/main-i18n.ts` | `translateMain` runs `rebrandText` |
| `src/renderer/src/i18n/i18n.ts` | registers `hawlBrandPostProcessor`, `postProcess: ['hawl-brand']` |

## Theme, terminal, art
| File | Hook |
|---|---|
| `src/renderer/src/assets/main.css` | one `@import` of `src/hawl/renderer/hawl-theme.css` (overrides use `html:root` / `html.dark`) |
| `src/shared/terminal-themes/index.ts` | adds `HAWL_TERMINAL_THEMES` to the catalog |
| `src/shared/default-global-settings.ts`, `src/shared/terminal-theme-selection.ts` | default terminal themes `Hawl Ember` / `Hawl Daylight`, divider colours |
| `resources/logo.svg`, `icon.png`, `icon-dev.png`, `build/icon.{png,ico,icns}`, `app-icons/orca-blue.png`, `app-icons/orca-watercolor.png`, `tray/orca-menu-barTemplate*.png`, `icon-source/icon.icon/Assets/logo.svg` | replaced with Hawl art (file names kept so no code changes). Not replaced yet: `resources/onboarding/feature-wall/*` (Orca UI recordings), Mac/Linux packaging art. |

## Vendor services off (all gated by `HAWL_VENDOR_SERVICES_ENABLED`)
| File | Hook |
|---|---|
| `src/main/telemetry/client.ts` | `TELEMETRY_ENABLED = false` (PostHog client never created) |
| `src/main/network/electron-proxy-request-guard.ts` | cancels any Chromium-stack request to hosts in `src/hawl/shared/blocked-hosts.ts` |
| `src/main/updater-nudge.ts`, `src/main/updater-changelog.ts` | no fetch of onorca.dev JSON |
| `src/main/plugins/plugin-kill-list-service.ts` | returns an empty list, no fetch |
| `src/main/ipc/feedback-request.ts` | `postFeedback` throws (feedback goes to GitHub issues) |
| `src/main/artifacts/artifact-cloud-config.ts` | no default share host |
| `src/main/orca-profiles/profile-cloud-auth-config.ts` | no default login/relay host, so Orca cloud sign-in reports "not configured" |
| `src/main/runtime/push/push-gateway-origin.ts`, `src/main/startup/main-process-push-startup.ts` | push gateway default empty, push startup skipped |
| `src/renderer/src/app-shell/AppRootSurfaces.tsx` | star-nag card, toast host and observer no longer mounted |
| `src/renderer/src/components/Landing.tsx` | no "Star on GitHub" footer |

## Links repointed (no network at startup)
`src/renderer/src/components/**` (Landing, StarNagCard, github-project/ProjectViewStates, link-routing-preference-dialog, mobile/mobile-platform-copy, settings/MobileSettingsPane, settings/TerminalWindowsAdministratorSection, settings/GeneralSupportSection, sidebar/SidebarFeedbackDialog, sidebar/SidebarSettingsHelpMenu, star-nag/StarNagToastHost, stats/ShareUsageButton, stats/share-card-utils, terminal-pane/TerminalErrorToast), `src/renderer/src/lib/telemetry.ts`, `src/shared/feature-wall-tiles.ts`, `src/shared/feature-wall-workflows.ts`, `src/shared/agent-feature-install-commands.ts`, `src/main/github/client/fetch/orca-star.ts`: Orca docs links go to `https://hawl.ai/docs`, changelog and downloads to our GitHub releases, `stablyai/orca` to `aaronlilla/hawl-workstation`.

## Plugins
| File | Hook |
|---|---|
| `src/shared/plugins/plugin-marketplace.ts` | official publisher/owner `aaronlilla`, id prefix `hawl-`, marketplace repo `aaronlilla/hawl-plugins` |
| `src/main/plugins/plugin-install-trust.ts`, `plugin-marketplace-provenance.ts` | error text |
| `resources/plugins/launch/*` | bundled plugin dirs renamed `aaronlilla.hawl-*`, manifests, marketplace index, `bundled-plugins.json` content hash recomputed |

## About
| File | Hook |
|---|---|
| `src/renderer/src/components/settings/GeneralPane.tsx` | renders `HawlAboutSection` (in `src/hawl/renderer/`) in place of the Orca "Support" section; the credit "Built on Orca (MIT)" lives there |

## Shell redesign (piece D4-shell, round 2; Hawl code in `src/hawl/renderer/`)
CSS: `hawl-theme.css` imports `hawl-pieces.css` (one `@import` per piece; `d4-shell.css` is this piece and imports `d4-shell-panels.css` and `d4-shell-pages.css`). Light theme only, every rule scoped `html:not(.dark)`; dark gets plain fallbacks. Code in `src/hawl/renderer/shell/`: `HawlNav` (sidebar navigation: Needs you, Work, Activity, Chat, Map, Agents, Files, then Automations and Phone), `HawlTopBar` (site switcher, search, Live lamp, Invite, account disc), `HawlSheet` + `hawl-lens.ts` (glass menus with a real refraction lens, built when a menu opens), `HawlLanding` + `HawlNeeds` (the Needs you home: real rows from local agents that wait on you or finished unseen, plus relay items), `HawlAbout` (About screen), `hawl-session.ts` (what sign-in M1 fills: user, sites, Live, relay items, row lamps; also `window.__hawlSession.set(...)`), `hawl-light.ts` (cursor-follow light on lit objects). Marked slots (`HawlSlot`, `registerHawlSlot` in `shell/HawlSlots.tsx`): `site-switcher`, `topbar-live`, `topbar-actions` (top bar), `yard-tree`, `foreman-strip` (sidebar).
| File | Hook |
|---|---|
| `src/renderer/src/app-shell/AppWorkspaceShell.tsx` | renders `<HawlTopBar />` at the top of the page column; class `hawl-page-column` on that column and `hawl-page-slab` on the content area |
| `src/renderer/src/app-shell/use-app-chrome-layout.ts` | Activity keeps the sidebar (only Settings and Space hide it), because the Hawl navigation lives there |
| `src/renderer/src/components/sidebar/index.tsx` | class `hawl-sidebar`; renders `<HawlSidebarBrand />`, then `<HawlNav />` in place of `SidebarNav`, `<HawlSlot name="yard-tree" />`, and above the footer `<HawlSlot name="foreman-strip" />` and `<HawlGetSetUp />` |
| `src/renderer/src/components/sidebar/SetupGuideSidebarEntry.tsx` | H01 "Get set up  N of M" row (flag icon, label, count) instead of the progress ring and "Onboarding checklist"; its test follows |
| `src/renderer/src/components/sidebar/SidebarSettingsHelpMenu.tsx` | Discord and X items removed, "About Hawl Workstation" item opens the About screen |
| `src/renderer/src/components/sidebar/SidebarToolbar.tsx` | class `hawl-sidebar-footer` (CSS turns Settings and Help into labelled rows) |
| `src/renderer/src/components/status-bar/StatusBarSurface.tsx` | class `hawl-statusbar` |
| `src/renderer/src/components/right-sidebar/index.tsx` | class `hawl-right-panel` |
| `src/renderer/src/components/Landing.tsx` | empty home renders `HawlLanding` (the Needs you page); wrapper class `hawl-home-wrap`; Orca markup, logo import and unused imports removed |
| `src/renderer/src/components/settings/GeneralPane.tsx` | (P1 hook) renders `HawlAboutSection`, now one row that opens the About screen |
| `config/tsconfig.tc.web.json` | `include` gains `../src/hawl/**/*` (without it `tc:web` fails TS6307 on every import of src/hawl) |

## Round 2 (critic fixes, from P1-rebrand)
| File | Hook |
|---|---|
| `src/main/startup/configure-process.ts`, `src/cli/runtime/metadata.ts`, `src/cli/runtime/launch-user-data-path.ts`, `src/cli/handlers/orchestration/runtime-compatibility.ts` | profile folder is `hawl-workstation` (dev `hawl-workstation-dev`), never stock Orca's `orca`/`orca-dev`; the CLI finds the same folder |
| `config/electron-builder.config.cjs` | `extraMetadata` name `hawl-workstation` / productName; NSIS artifact `hawl-workstation-windows-setup.exe` |
| `config/nsis/orca-installer-hooks.nsh`, `src/main/daemon/daemon-host-relocation.ts` | ProgIDs `Hawl.Markdown`/`Hawl.Tabular`; daemon host root `%LOCALAPPDATA%\Hawl`; uninstall no longer kills `orca-terminal-daemon.exe` (stock Orca's) |
| `src/shared/pairing.ts`, `src/shared/skill-share-link.ts` | `hawl://` accepted next to `orca://` |
| `src/main/telemetry/client.ts` | PostHog transport deleted, no-op stub with the same exports (its 3 transport tests and harness removed, plus 2 usage tests that only asserted telemetry events) |
| `src/main/updater-nudge.ts`, `src/main/updater-changelog.ts` | hosted feeds removed (no fetch code) |
| `src/main/artifacts/artifact-cloud-config.ts`, `plugin-kill-list-service.ts`, `src/main/ipc/feedback-request.ts` | vendor URLs removed (feedback points at an `.invalid` host and is gated off) |
| `src/renderer/src/hooks/settings-navigation-capability-sections.ts`, `settings-setup-workflow-section-renderers.tsx` | Orca account pane hidden |
| `src/shared/constants.ts`, `src/main/ipc/worktree-logic.ts`, `src/main/ipc/repos/repo-creation-handlers.ts`, `create-project-defaults.ts`, `terminal-preview-content.ts` | default dirs `~/hawl/workspaces`, `~/hawl/projects`; theme default `light` (`default-global-settings.ts`); UI font default `Hawl Inter` |
| `src/renderer/src/assets/main.css`, `settings/orca-logo-settings-icon.tsx` | no logo invert (orange mark in both themes) |
| `package.json` | version 0.1.0 |

## Known leftovers (not changed)
- CLI and skills are still named `orca` (`orca.cmd`, `orca account add`, `orca emulator`, skill `orca-linear`), plus `ORCA_*` env vars, `~/.orca` (shared with stock Orca: keybindings, agent hooks, credentials) and the dev launcher `Orca Devin\orca-dev.cmd`. Renaming touches the CLI, installers and hundreds of tests; planned as its own piece.
- Skill install points at `github.com/aaronlilla/hawl-workstation`, which does not exist until the repo is published; the pinned commit is the local one.
- `mobile/` Expo app still points at Orca hosts (M6). Feature-wall onboarding GIFs show Orca's UI. Mac/Linux packaging art, `posthog-node` still listed in package.json (unused).
- Packaged build (`build:win`) and installer not run.

## Round 3 (every working page, not only the Needs you home)
CSS: `d4-shell-r3.css` (pages: heading, ground, pills, wells, keys) and `d4-shell-r3b.css` (empty-state cards, narrow top bar, glass menus and pickers, Settings switches and selects, terminal well, status bar, wide and small windows), both under `src/hawl/renderer/`, imported from `d4-shell.css`. New code: `shell/HawlPageHead.tsx` (Work, Activity and Phone headings), `shell/HawlAgents.tsx` and `shell/hawl-page.ts` (the Agents page; Needs you and Agents share the home column).
| File | Hook |
|---|---|
| `src/renderer/src/app-shell/AppWorkspaceShell.tsx` | renders `<HawlPageHead />` above the slab; slab gets `data-hawl-view` (home, workspace or the page) and `data-hawl-panel` (right panel open or closed) |
| `src/renderer/src/components/Landing.tsx` | create label is always "Workspace" (was Worktree or Workspace by repo kind) |
| `src/renderer/src/components/artifacts/ArtifactsPage.tsx` (+ test) | page title "Files" (was "Artifacts") |
| `src/renderer/src/components/sidebar/SidebarToolbar.tsx` (+ test) | the "Workspace board moved" first-launch hint is off (`WORKSPACE_BOARD_MOVED_HINT_ENABLED = false`) |
| `src/renderer/src/components/sidebar/SidebarSettingsHelpMenu.tsx` (+ test) | Send Feedback, Milestones and Onboarding are behind `HAWL_HELP_ORCA_ITEMS = false`; stale Discord, X and Restart tests updated |
| `src/hawl/shared/terminal-themes.ts` | Hawl Daylight terminal is a cream well (`#fcf6e7`, ink `#2b2318`) instead of white |
