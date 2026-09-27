import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  // Nuxt replaces these flags at build time; tests run in Node, so define them
  // for app-side modules (e.g. the draft store) that branch on `import.meta.client`.
  define: {
    'import.meta.client': 'true',
    'import.meta.server': 'false',
  },
  resolve: {
    alias: {
      // Matches Nuxt's srcDir alias, so app-side modules (the markdown renderer)
      // can be imported by tests.
      '~': resolve(import.meta.dirname, './app'),
      '@server': resolve(import.meta.dirname, './server'),
      '@shared': resolve(import.meta.dirname, './server/shared'),
    },
  },
})
