# FORK-HOOKS

Every Orca file this fork edits. After each upstream merge, re-check exactly these files. All Hawl code lives in `src/hawl/`; Orca files only get the small hooks below. Last updated at piece D1-foundations round 8 (no new Orca file edits: round 8 is theme CSS only) (theme CSS is `src/hawl/renderer/theme/*.css`, one import list in `index.css`).

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
| `resources/logo.svg`, `icon.png`, `icon-dev.png`, `build/icon.{png,ico,icns}`, `app-icons/orca-blue.png`, `app-icons/orca-watercolor.png`, `tray/orca-menu-barTemplate*.png`, `icon-source/icon.icon/Assets/logo.svg` | replaced with Hawl art (file names kept so no code changes). Mac/Linux packaging art is not replaced (Windows is the shipped target); the feature-wall tiles are Hawl cards (see Round 3). |

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

## Round 3 (critic fixes)
| File | Hook |
|---|---|
| `src/renderer/src/components/settings/PrivacyPane.tsx` | page states "No usage data is collected"; no switch, no diagnostics upload section (telemetry is removed, so the old toggle was false) |
| `config/electron-builder.config.cjs` | Windows exe is `Hawl.exe` (`win.executableName`) |
| `config/dev-app-update.yml`, `config/packaged-runtime-node-modules.cjs`, `package.json`, `pnpm-lock.yaml` | update feed repo `hawl-workstation`; `posthog-node` removed |
| `src/main/artifacts/artifact-cloud-config.ts` | only loopback hosts accepted, no `onorca.dev` allow-list |
| `src/main/cli/cli-install-location.ts` | dev CLI folder `Hawl Dev` (was stock Orca's `Orca Dev`) |
| `src/main/macos-*.ts`, `src/main/daemon/macos-daemon-job-label.ts`, `src/main/computer/macos-computer-use-permissions.ts`, `src/main/ipc/notification-system-settings-link.ts`, `src/shared/local-build-compatibility-contract.*` | macOS bundle ids `com.hawl.workstation*` |
| `src/renderer/src/lib/agent-catalog.tsx`, `open-in-app-catalog.tsx`, `src/shared/repo-icon.ts` | no Google favicon requests (they leaked domain names); letter or generic icon instead |
| `src/renderer/src/components/mobile/slides/HomeSlide.tsx` | sample emails `example.com` |
| `src/renderer/src/app-shell/TitlebarLeftControls.tsx`, `src/renderer/src/components/Landing.tsx` | F16 horizontal wordmark (`src/hawl/renderer/assets/`) in the titlebar and the empty state |
| `resources/onboarding/feature-wall/*`, `resources/app-icons/*` | regenerated by `src/hawl/tools/make-brand-art.py` (Hawl cards, two distinct Hawl icons) |
| `src/renderer/src/components/settings/WorkspaceDirectorySetting.tsx` | hint example `.hawl/worktrees` |

Complete list of edited Orca files: generated by `node src/hawl/tools/list-fork-hooks.mjs` (see the end of this file). Test files edited alongside are not listed.

## Round 4 (critic fixes)
| File | Hook |
|---|---|
| `src/main/startup/configure-process.ts` | an explicit `--user-data-dir` wins on packaged runs (before, a launch with its own profile folder silently used `%APPDATA%\hawl-workstation`, so "fresh profile" runs were not fresh) |
| `native/windows-cli-launcher/src/main.rs`, `Cargo.toml`, `build.rs`, `src/administrator_restart.rs`, `native/windows-agent-hook/build.rs`, `config/scripts/build-windows-cli-launcher.mjs`, `config/electron-builder.config.cjs`, `resources/win32/bin/hws.cmd` | the CLI launcher looked for `Orca.exe`, so the packaged CLI failed with "Unable to locate Orca.exe"; it now finds `Hawl.exe`. New documented command `hws` (`hws.exe`, `hws.cmd`; not `hawl`, which is the Hawl platform CLI on the same PATH) ships beside `orca` (compatibility name agents and hooks call). PE metadata says Hawl Workstation, Hawl, "Built on Orca (MIT)" |
| `config/tsconfig.cli.json`, `src/cli/index.ts`, `src/main/index.ts`, `src/hawl/main/env-aliases*.ts` | `HAWL_BITBUCKET_*`, `HAWL_AZURE_DEVOPS_*`, `HAWL_GITEA_*` are copied to the `ORCA_*` names the code reads (main and CLI); the settings screens show the HAWL_ names |
| `src/hawl/shared/brand.ts` | `rebrandText` also rewrites those env names and a backticked `orca` command to `hws`; `displayCommandName` |
| `src/renderer/src/components/settings/CliSection.tsx`, `use-cli-registration-actions.ts`, `ManagedDataAccountsSection.tsx`, `MobileEmulatorAgentControlRow.tsx`, `BrowserUseExamples.tsx`, `MobileEmulatorExamples.tsx` | visible `orca` commands and "Using Orca CLI" prompts say `hws` |
| `src/main/azure-devops/pull-request-creation.ts`, `bitbucket/pull-request-creation.ts`, `gitea/pull-request-creation.ts`, `source-control/hosted-review-creation-provider.ts`, `src/renderer/src/components/right-sidebar/source-control-create-review-blocked-action.ts` | error and hint text name the HAWL_ variables |
| `src/shared/feature-tips.ts` | the CLI tip says what its button does: "Add CLI to PATH & install skills" |
| `src/shared/terminal-platform-defaults.ts`, `src/renderer/src/main.tsx`, `src/hawl/renderer/preload-fonts.ts` | default terminal font is the bundled JetBrains Mono (F15), loaded at startup so xterm measures the right glyph widths |
| `src/hawl/renderer/hawl-theme.css` | H01 materials: lit ground, glass title bar and sidebars, key-style sidebar buttons, orange pill for the open workspace, recessed inputs; larger titlebar wordmark |

## Known leftovers (not changed)
- Internal names that are still Orca's: `resources\bin\orca.exe`, `orca.cmd`, `orca-agent-hook.exe`, `orca-administrator-restart.exe` (agents, hooks and tests call them; `hawl.exe`/`hawl.cmd` are the documented command), the skill `orca-linear`, WSL guest `orca-ide`, terminal env vars `ORCA_*`, and `~/.orca` (keybindings, agent hooks, credentials; shared with an installed stock Orca). Renaming touches hundreds of tests; planned as its own piece.
- Skill install points at `github.com/aaronlilla/hawl-workstation`, which has no releases yet, so the update check, `latest.yml` and `agent-state-rules.json` downloads return 404 until the first release is published (the app keeps the bundled rules).
- `mobile/` Expo app still points at Orca hosts (M6). Mac/Linux packaging art. `api.anthropic.com/api/oauth/usage` is called to show the user's own Claude usage (their token, not vendor). Windows code-signing publisher in the builder config is still SignPath (unsigned dev builds).

## Complete list of edited Orca files (generated)

Base 20fc7af55, from `node src/hawl/tools/list-fork-hooks.mjs`. Folder-level rows above give the reason; this list is exhaustive.

154 files (tests excluded; test files changed alongside are not listed)

- `./`: `FORK-HOOKS.md`, `PROJECT.md`, `package.json`, `pnpm-lock.yaml`
- `config/`: `dev-app-update.yml`, `electron-builder.config.cjs`, `packaged-runtime-node-modules.cjs`, `vitest.config.ts`
- `config/nsis/`: `orca-installer-hooks.nsh`
- `config/scripts/`: `build-computer-macos.mjs`, `build-notification-status-macos.mjs`, `dev-electron-bundle-identity.mjs`, `macos-launch-diagnostics.sh`, `macos-terminal-host-bundle.cjs`
- `resources/`: `icon-dev.png`, `icon.png`, `logo.svg`
- `resources/app-icons/`: `orca-blue.png`, `orca-watercolor.png`
- `resources/build/`: `icon.icns`, `icon.ico`, `icon.png`
- `resources/icon-source/icon.icon/Assets/`: `logo.svg`
- `resources/onboarding/feature-wall/`: `tile-01.gif`, `tile-01.poster.jpg`, `tile-01.recorded-at.json`, `tile-02.gif`, `tile-02.poster.jpg`, `tile-02.recorded-at.json`, `tile-03.gif`, `tile-03.poster.jpg`, `tile-03.recorded-at.json`, `tile-04.gif`, `tile-04.poster.jpg`, `tile-04.recorded-at.json`, `tile-05.gif`, `tile-05.poster.jpg`, `tile-05.recorded-at.json`, `tile-06.gif`, `tile-06.poster.jpg`, `tile-06.recorded-at.json`, `tile-07.gif`, `tile-07.poster.jpg`, `tile-07.recorded-at.json`, `tile-08.gif`, `tile-08.poster.jpg`, `tile-08.recorded-at.json`, `tile-09.gif`, `tile-09.poster.jpg`, `tile-09.recorded-at.json`, `tile-10.gif`, `tile-10.poster.jpg`, `tile-10.recorded-at.json`, `tile-11.gif`, `tile-11.poster.jpg`, `tile-11.recorded-at.json`, `tile-12.gif`, `tile-12.poster.jpg`, `tile-12.recorded-at.json`
- `resources/plugins/launch/`: `bundled-plugins.json`, `orca-marketplace.json`
- `resources/plugins/launch/aaronlilla.hawl-multipass-recipes/`: `orca-plugin.json`
- `resources/plugins/launch/aaronlilla.hawl-multipass-recipes/recipes/`: `ubuntu-lts.json`
- `resources/plugins/launch/aaronlilla.hawl-navigation-shortcuts/`: `orca-plugin.json`
- `resources/plugins/launch/aaronlilla.hawl-portuguese/`: `orca-plugin.json`
- `resources/plugins/launch/aaronlilla.hawl-portuguese/locales/`: `pt-BR.json`
- `resources/tray/`: `orca-menu-barTemplate.png`, `orca-menu-barTemplate@2x.png`
- `src/cli/handlers/orchestration/`: `runtime-compatibility.ts`
- `src/cli/runtime/`: `launch-user-data-path.ts`, `metadata.ts`
- `src/main/`: `macos-press-and-hold-default.ts`, `macos-tcc-prompt-watch.ts`, `updater-changelog.ts`, `updater-nudge.ts`, `updater-prerelease-feed.ts`, `updater-test-harness.ts`
- `src/main/artifacts/`: `artifact-cloud-config.ts`
- `src/main/cli/`: `cli-install-location.ts`
- `src/main/computer/`: `macos-computer-use-permissions.ts`
- `src/main/daemon/`: `daemon-host-relocation.ts`, `macos-daemon-job-label.ts`
- `src/main/github/client/fetch/`: `orca-star.ts`
- `src/main/i18n/`: `main-i18n.ts`
- `src/main/ipc/`: `feedback-request.ts`, `notification-system-settings-link.ts`, `worktree-logic.ts`
- `src/main/ipc/repos/`: `repo-creation-handlers.ts`
- `src/main/network/`: `electron-proxy-request-guard.ts`
- `src/main/orca-profiles/`: `profile-cloud-auth-config.ts`
- `src/main/plugins/`: `plugin-install-trust.ts`, `plugin-kill-list-service.ts`, `plugin-marketplace-provenance.ts`
- `src/main/plugins/__mocks__/`: `plugin-uninstall-log-test-fixture.ts`
- `src/main/runtime/push/`: `push-gateway-origin.ts`
- `src/main/startup/`: `configure-process.ts`, `dev-instance-identity.ts`, `main-process-push-startup.ts`
- `src/main/telemetry/`: `client-test-harness.ts`, `client.ts`
- `src/main/updater/`: `updater-release-feed.ts`, `updater-setup.ts`
- `src/main/window/`: `createMainWindow.ts`
- `src/renderer/`: `index.html`, `popout.html`, `space.html`, `web-index.html`
- `src/renderer/src/app-shell/`: `AppRootSurfaces.tsx`, `TitlebarLeftControls.tsx`
- `src/renderer/src/assets/`: `main.css`
- `src/renderer/src/components/`: `Landing.tsx`, `StarNagCard.tsx`, `link-routing-preference-dialog.tsx`
- `src/renderer/src/components/github-project/`: `ProjectViewStates.tsx`
- `src/renderer/src/components/mobile/`: `mobile-platform-copy.ts`
- `src/renderer/src/components/mobile/slides/`: `HomeSlide.tsx`
- `src/renderer/src/components/onboarding/`: `OnboardingFlow.tsx`
- `src/renderer/src/components/settings/`: `GeneralPane.tsx`, `GeneralSupportSection.tsx`, `MobileSettingsPane.tsx`, `PrivacyPane.tsx`, `TerminalWindowsAdministratorSection.tsx`, `WorkspaceDirectorySetting.tsx`, `settings-remote-security-section-renderers.tsx`, `settings-setup-workflow-section-renderers.tsx`, `terminal-preview-content.ts`
- `src/renderer/src/components/sidebar/`: `SidebarFeedbackDialog.tsx`, `SidebarSettingsHelpMenu.tsx`, `create-project-defaults.ts`
- `src/renderer/src/components/star-nag/`: `StarNagToastHost.tsx`
- `src/renderer/src/components/stats/`: `ShareUsageButton.tsx`, `share-card-utils.tsx`
- `src/renderer/src/components/terminal-pane/`: `TerminalErrorToast.tsx`
- `src/renderer/src/hooks/`: `settings-navigation-capability-sections.ts`, `settings-navigation-remote-sections.ts`
- `src/renderer/src/i18n/`: `i18n.ts`
- `src/renderer/src/lib/`: `agent-catalog.tsx`, `open-in-app-catalog.tsx`, `telemetry.ts`
- `src/shared/`: `agent-feature-install-commands.ts`, `constants.ts`, `default-global-settings.ts`, `feature-wall-tiles.ts`, `feature-wall-workflows.ts`, `local-build-compatibility-contract.json`, `local-build-compatibility-contract.ts`, `pairing.ts`, `release-channel.ts`, `repo-icon.ts`, `serve-bundle-coordination.ts`, `skill-share-link.ts`, `terminal-theme-selection.ts`
- `src/shared/plugins/`: `plugin-marketplace.ts`
- `src/shared/terminal-themes/`: `index.ts`

## D1-foundations (theme)

| File | Hook |
|---|---|
| `src/renderer/src/assets/main.css`, `src/renderer/src/main.tsx` | import `src/hawl/renderer/theme/index.css` and start the light engine |
| `src/renderer/src/components/crash-report/CrashReportDialogSurface.tsx` | "Orca" in the crash dialog text becomes "Hawl" |
| `src/renderer/src/components/Landing.tsx` | empty home: dark logo plate and "ORCA" text replaced by the Hawl wordmark (light and dark SVG from `src/hawl/renderer/assets/`) straight on the ground |
| `src/renderer/src/components/Landing.tsx` | D1 round 5: class `hawl-lit` on the Add project button (lit primary on the empty home). |

## Round 5 (critic fixes)
| File | Hook |
|---|---|
| `src/main/updater/updater-menu-checks.ts`, `src/main/updater/updater-scheduling.ts`, `src/main/runtime/agent-state-rules/agent-state-rules-live-update.ts` | no update check or agent-rule download while `HAWL_RELEASE_FEED_LIVE` is false (our release repo is not published yet, so every request would be a 404) |
| `src/main/cli/cli-command-inspection.ts`, `cli-path-registration.ts`, `wsl-cli-installer.ts` | "use Orca from" text says Hawl |
| `src/shared/orca-cli-command-name.ts` (+ one expectation in `terminal-creation-and-readiness-part-02.spec.ts`) | Windows launch command is `hws.cmd` |
| `src/renderer/src/components/settings/CliSection.tsx`, `MobileEmulatorExamples.tsx`, `CliSection.install-failure.test.tsx` | show `hws.exe` / `hws` instead of `orca.exe` / `orca` |
| `src/renderer/src/components/mobile/slides/HomeSlide.tsx`, `TerminalSlide.tsx`, `WorktreeListSlide.tsx` | the phone mock shows the Hawl mark and `hawl` sample repo names (no Orca whale or repo name) |
| `config/electron-builder.config.cjs` | `copyright` carries the Orca / Lovecast credit (EXE metadata) |

