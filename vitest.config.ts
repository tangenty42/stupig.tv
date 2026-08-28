import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@server': resolve(import.meta.dirname, './server'),
      '@shared': resolve(import.meta.dirname, './server/shared'),
    },
  },
})
