import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig } from '@playwright/test'
import production from './css-production.config'

for (const binary of ['chromium/chrome-win/chrome.exe', 'chromedriver/chromedriver.exe', 'firefox/core/firefox.exe', 'geckodriver/geckodriver.exe']) {
  if (! existsSync(resolve('.dev/tools/legacy-browsers', binary)))
    throw new Error(`Install the historical browser fixture before building: ${binary}; see docs/reviews/css-legacy-engines-2026-10-29.md`)
}

export default defineConfig(production, {
  testMatch: ['css-legacy-browsers.spec.ts', ... (Array.isArray(production.testMatch) ? production.testMatch : [])],
  outputDir: '../.dev/css-legacy/results',
  reporter: [['list'], ['json', { outputFile: '../.dev/css-legacy/report.json' }]],
  projects: [
    // Native login, hard navigation and editing run under x64 emulation on
    // ARM Windows. Give driver operations a separate budget from modern CI.
    { name: 'chromium80', testMatch: ['css-legacy-browsers.spec.ts'], timeout: 240_000, expect: { timeout: 60_000 } },
    { name: 'firefox78', testMatch: ['css-legacy-browsers.spec.ts'], timeout: 240_000, expect: { timeout: 60_000 } },
    { name: 'modern-chromium', testMatch: production.testMatch },
  ],
})
