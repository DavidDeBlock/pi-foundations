import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    include: ['scripts/**/*.test.ts', 'shared/**/*.test.ts'],
    environment: 'node',
    pool: 'threads',
    poolOptions: {
      threads: {
        singleThread: true
      }
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov']
    }
  }
})
