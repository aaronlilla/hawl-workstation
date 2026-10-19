// Standalone test config for @hawl/client, so Orca's own vitest setup stays untouched.
// Run from the repo root: node_modules/.bin/vitest run --config src/hawl/shared/client/vitest.config.ts --maxWorkers=2
import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  root: resolve(__dirname, '../../../..'),
  test: {
    environment: 'node',
    include: ['src/hawl/shared/client/**/*.test.ts'],
    testTimeout: 15_000
  }
})
