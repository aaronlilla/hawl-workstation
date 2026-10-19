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
| `src/hawl/renderer/hawl-theme.css` | two `@import`s, `./themes/d2-controls.css`, `./themes/d2-controls-r2.css` and `./themes/d2-controls-r3.css` (round 2: sizes, glass secondary, menus, avatars)` (piece D2-controls: lit buttons, switch, checkbox, slider, fields, chips, status lights, progress, tooltip, segmented; CSS only, reaches Orca's `src/renderer/src/components/ui/*` through their `data-slot` / `data-variant` attributes, no component edited) |
| `src/renderer/src/main.tsx` | one `import '../../hawl/renderer/themes/d2-controls'` (D2-controls: the pointer-light follower, one delegated listener) |
| `src/renderer/src/components/Landing.tsx` | no "Star on GitHub" footer |
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

## Round 2 (critic fixes)
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
- `mobile/` Expo app still points at Orca hosts (M6).
- `hawl://` is registered with the OS but only `orca://` links are parsed in code.
- Orca-named internals: CLI `orca`, `orca-dev`, Windows NSIS script, `%LOCALAPPDATA%\Orca` paths, macOS bundle ids in main-process helpers.
- Feature-wall onboarding GIFs show Orca's UI.
- Existing unit tests that assert the old defaults (terminal theme names, bundled plugin ids, feed URLs) are not updated yet.
| `src/renderer/src/components/Landing.tsx` | D2-controls r3: wrapper class `hawl-landing-actions` on the home buttons, and "Add project" is the orange `bg-primary` key while no project exists (CSS cannot change which button is primary) |
- CLI and skills are still named `orca` (`orca.cmd`, `orca account add`, `orca emulator`, skill `orca-linear`), plus `ORCA_*` env vars, `~/.orca` (shared with stock Orca: keybindings, agent hooks, credentials) and the dev launcher `Orca Devin\orca-dev.cmd`. Renaming touches the CLI, installers and hundreds of tests; planned as its own piece.
- Skill install points at `github.com/aaronlilla/hawl-workstation`, which does not exist until the repo is published; the pinned commit is the local one.
- `mobile/` Expo app still points at Orca hosts (M6). Feature-wall onboarding GIFs show Orca's UI. Mac/Linux packaging art, `posthog-node` still listed in package.json (unused).
- Packaged build (`build:win`) and installer not run.
