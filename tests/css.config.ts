import { defineConfig, devices } from '@playwright/test'

// Component CSS verification has no application server, database or cloud
// boundary. CI runs this suite in the dedicated browser-css job.
export default defineConfig({
  testDir: './e2e',
  testMatch: 'css-official-apis.spec.ts',
  workers: 1,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  timeout: 30_000,
  expect: { timeout: 5000 },
  outputDir: '../.dev/css-official-apis/results',
  reporter: [['list'], ['json', { outputFile: '../.dev/css-official-apis/report.json' }]],
  use: { ... devices['Desktop Chrome'], trace: 'retain-on-failure', screenshot: 'only-on-failure' },
})
