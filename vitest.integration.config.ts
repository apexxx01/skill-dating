import { defineConfig } from 'vitest/config'
import path from 'path'

// Separate from vitest.config.ts on purpose: these tests spin up a real
// Next.js dev server against a real, disposable database and make real
// HTTP calls - they're slow and must run sequentially (one shared server),
// unlike the fast, parallel, mocked-Prisma unit tests `npm test` runs.
// `npm test` is unaffected by this file; run these with `npm run test:integration`.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/integration/**/*.test.ts'],
    globalSetup: ['tests/integration/global-setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    fileParallelism: false,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
})
