import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    testTimeout: 15_000,
    // Git/process-heavy integration suites contend badly at the default
    // machine-wide worker count and can cross their safety timeout despite
    // passing in isolation. Bound concurrency without relaxing normal tests.
    minWorkers: process.platform === 'win32' ? 1 : 2,
    maxWorkers: process.platform === 'win32' ? 2 : 6,
  },
})
