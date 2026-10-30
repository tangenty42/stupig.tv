import { defineConfig } from '@playwright/test'
import legacy from './css-legacy.config'

const workflows = ['content-cloud-draft.spec.ts', 'content-draft-*.spec.ts', 'content-reference-*.spec.ts', 'css-production-ssr.spec.ts']

// Reuse the real production compiler and historical-browser fixtures; runtime
// still points only at the launcher's disposable database and bounded broker.
export default defineConfig(legacy, {
  testMatch: [... workflows, 'css-legacy-browsers.spec.ts'],
  outputDir: '../.dev/cloud-drafts-production/results',
  reporter: [['list'], ['json', { outputFile: '../.dev/cloud-drafts-production/report.json' }]],
  projects: [
    ... (legacy.projects ?? []).filter(project => project.name !== 'modern-chromium'),
    { name: 'modern-chromium', testMatch: workflows },
  ],
})
