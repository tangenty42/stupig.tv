import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
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
