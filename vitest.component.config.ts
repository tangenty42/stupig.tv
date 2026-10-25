import { resolve } from 'node:path'
import { defineVitestConfig } from '@nuxt/test-utils/config'

export default defineVitestConfig({
  test: {
    name: 'components',
    include: ['app/**/*.nuxt.test.ts'],
    environment: 'nuxt',
    maxWorkers: 1,
    testTimeout: 15_000,
    hookTimeout: 30_000,
    environmentOptions: {
      nuxt: {
        rootDir: resolve('.'),
        overrides: {
          buildDir: '.nuxt/component-tests',
          ignore: ['**/app/plugins/**'],
        },
      },
    },
  },
})
