// Light config for Hawl code: pure modules need none of Orca's setup files or workspace builds.
// Run: node_modules/.bin/vitest run --config src/hawl/vitest.config.ts --maxWorkers=2
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/hawl/**/*.test.ts'],
    pool: 'forks'
  }
})
