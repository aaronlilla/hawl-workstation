# Fork hooks

Edits to Orca's own files. Keep each small.

| File | Change | Why | Piece |
| --- | --- | --- | --- |
| config/tsconfig.node.json | `include` adds `../src/hawl/shared/client/**/*`; `compilerOptions.paths` maps `@hawl/client` to `../src/hawl/shared/client/index.ts` | Orca's node typecheck covers the client and resolves its name | P2-client |
| electron.vite.config.ts | main `resolve.alias['@hawl/client']` | the main process bundle imports it by name | P2-client |
| config/vitest.config.ts | alias `@hawl/client` | Orca's test run resolves it | P2-client |
