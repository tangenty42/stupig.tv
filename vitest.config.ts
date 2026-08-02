import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@server': resolve(__dirname, './server'),
      '@shared': resolve(__dirname, './server/shared'),
    },
  },
})
