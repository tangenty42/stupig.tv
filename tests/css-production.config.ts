import { defineConfig, devices } from '@playwright/test'
import { e2e_target } from '../scripts/testing/e2e-target'

const target = e2e_target(process.argv.slice(2), process.env.STUPIG_E2E_SHARD)
process.env.STUPIG_E2E_SHARD = `${target.shard.current}/${target.shard.total}`
const artifacts = target.shard.total > 1 ? `-shard-${target.shard.current}` : ''

export default defineConfig({
  testDir: './e2e',
  testMatch: ['css-production-*.spec.ts', 'content-sticky-headings.spec.ts', 'content-editor-scroll-alignment.spec.ts', 'content-iframe-carousel.spec.ts', 'content-cloud-draft.spec.ts'],
  globalSetup: '../scripts/testing/browser.ts',
  metadata: { productionCss: true },
  workers: 1,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  outputDir: `../.dev/css-production/results${artifacts}`,
  reporter: [['list'], ['json', { outputFile: `../.dev/css-production/report${artifacts}.json` }]],
  use: { ... devices['Desktop Chrome'], baseURL: target.baseUrl, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
})
