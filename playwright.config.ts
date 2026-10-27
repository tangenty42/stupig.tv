import { defineConfig, devices } from '@playwright/test'
import { e2e_target } from './scripts/testing/e2e-target'

const target = e2e_target(process.argv.slice(2))
// 本机并行分片不能互相覆盖 trace 与报告；未分片时路径与文档一致。
const artifacts = target.shard.total > 1 ? `-shard-${target.shard.current}` : ''

export default defineConfig({
  testDir: './tests/e2e',
  globalSetup: './scripts/testing/browser.ts',
  workers: 1,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  outputDir: `.dev/playwright/results${artifacts}`,
  reporter: process.env.CI ? [['list'], ['html', { outputFolder: `.dev/playwright/report${artifacts}`, open: 'never' }]] : 'list',
  use: { ... devices['Desktop Chrome'], baseURL: target.baseUrl, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
})
