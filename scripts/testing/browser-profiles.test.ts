import { execFileSync } from 'node:child_process'
import { basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

interface Suite { suites?: Suite[], specs?: { file: string }[] }

function listed_files(config: string) {
  const env = { ... process.env }
  delete env.STUPIG_E2E_SHARD
  const output = execFileSync(process.execPath, [fileURLToPath(import.meta.resolve('@playwright/test/cli')), 'test', '--config', config, '--list', '--reporter=json'], {
    encoding: 'utf8', env, timeout: 15_000, windowsHide: true,
  })
  const report = JSON.parse(output) as { errors: unknown[], suites: Suite[] }
  expect(report.errors).toEqual([])
  const files = new Set<string>()
  const visit = (suite: Suite) => {
    for (const spec of suite.specs ?? [])
      files.add(basename(spec.file.replaceAll('\\', '/')))
    for (const child of suite.suites ?? [])
      visit(child)
  }
  for (const suite of report.suites)
    visit(suite)
  return files
}

it('selects disjoint application, production layout and component CSS suites through the real CLI', () => {
  const application = listed_files('playwright.config.ts')
  const production = listed_files('tests/css-production.config.ts')
  const components = listed_files('tests/css.config.ts')
  expect([... application].filter(file => production.has(file) || components.has(file))).toEqual([])
  expect([... production].filter(file => components.has(file))).toEqual([])
  expect(application.has('content-cloud-draft.spec.ts')).toBe(true)
  expect(production.has('content-cloud-draft.spec.ts')).toBe(false)
  for (const file of ['content-sticky-headings.spec.ts', 'content-editor-scroll-alignment.spec.ts', 'content-iframe-carousel.spec.ts']) {
    expect(production.has(file), file).toBe(true)
    expect(application.has(file), file).toBe(false)
  }
  expect(components.has('css-official-apis.spec.ts')).toBe(true)
  expect([... production].some(file => file.startsWith('css-production-'))).toBe(true)
}, 45_000)
