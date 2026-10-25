import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './tests/e2e',
  globalSetup: './scripts/testing/browser.ts',
  workers: 1,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  outputDir: '.dev/playwright/results',
  reporter: process.env.CI ? [['list'], ['html', { outputFolder: '.dev/playwright/report', open: 'never' }]] : 'list',
  use: { ... devices['Desktop Chrome'], baseURL: 'http://localhost:3142', trace: 'retain-on-failure', screenshot: 'only-on-failure' },
})
