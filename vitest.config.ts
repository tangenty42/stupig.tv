import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      // Matches Nuxt's srcDir alias, so app-side modules (the markdown renderer)
      // can be imported by tests.
      '~': resolve(import.meta.dirname, './app'),
      '@config': resolve(import.meta.dirname, './config/lib'),
      '@server': resolve(import.meta.dirname, './server'),
      '@shared': resolve(import.meta.dirname, './server/shared'),
    },
  },
  test: {
    maxWorkers: 4,
    projects: [
      {
        extends: true,
        define: { 'import.meta.client': 'true', 'import.meta.server': 'false' },
        test: { name: 'app', include: ['app/**/*.test.ts'], exclude: ['**/*.nuxt.test.ts'] },
      },
      {
        extends: true,
        define: { 'import.meta.client': 'false', 'import.meta.server': 'true' },
        test: { name: 'server', include: ['server/**/*.test.ts', 'config/**/*.test.ts'] },
      },
      {
        extends: true,
        test: { name: 'tools', include: ['scripts/**/*.test.ts', 'eslint.local-rules.test.ts'], fileParallelism: false, testTimeout: 15_000 },
      },
    ],
  },
})
