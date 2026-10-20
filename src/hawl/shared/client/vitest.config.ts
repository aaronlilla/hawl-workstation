// Standalone test config for @hawl/client, so Orca's own vitest setup stays untouched.
// Run from the repo root: node_modules/.bin/vitest run --config src/hawl/shared/client/vitest.config.ts --maxWorkers=2
import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  root: resolve(__dirname, '../../../..'),
  resolve: { alias: { '@hawl/client': resolve(__dirname, 'index.ts') } },
  test: {
    environment: 'node',
    include: ['src/hawl/shared/client/**/*.test.ts'],
    testTimeout: 15_000,
    // The smoke files sign in with the same local owner; two at once overwrite each other's emailed code.
    fileParallelism: false
  }
})
