import { defineConfig } from 'vitest/config'
import path from 'path'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'prisma/**/*.test.ts'],
    // Dummy values for the settings src/lib/env.ts requires, so modules that read
    // `env` can be exercised without a .env file. Nothing here is a real credential.
    env: {
      DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/unit_tests?schema=public',
      NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: 'pk_test_unit',
      CLERK_SECRET_KEY: 'sk_test_unit',
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
})
