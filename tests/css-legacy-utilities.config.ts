import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  testMatch: ['css-legacy-utilities.spec.ts'],
  workers: 1,
  retries: 0,
  timeout: 120_000,
  outputDir: '../.dev/css-legacy-utilities/results',
  reporter: [['list'], ['json', { outputFile: '../.dev/css-legacy-utilities/report.json' }]],
  projects: [{ name: 'chromium80' }, { name: 'firefox78' }],
})
