import { fileURLToPath } from 'node:url'
import browserslist from 'browserslist'

const css_engines: Record<string, string> = { chrome: 'chrome', edge: 'edge', firefox: 'firefox', safari: 'safari' }

/** Translate the declared support range without silently omitting an engine. */
export function css_targets(queries: readonly string[]) {
  const versions = new Map<string, string[]>()
  for (const browser of browserslist([... queries])) {
    const [engine, range] = browser.split(' ')
    const target = engine && css_engines[engine]
    const version = range?.split('-')[0]
    if (! target || ! version || ! /^\d+(?:\.\d+)*$/.test(version))
      throw new Error(`Unsupported CSS browser target: ${browser}`)
    const candidates = versions.get(target) ?? []
    candidates.push(version)
    versions.set(target, candidates)
  }
  return [... versions.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([engine, candidates]) => {
    candidates.sort((a, b) => {
      const left = a.split('.').map(Number)
      const right = b.split('.').map(Number)
      for (let i = 0; i < Math.max(left.length, right.length); i ++) {
        const difference = (left[i] ?? 0) - (right[i] ?? 0)
        if (difference)
          return difference
      }
      return 0
    })
    return `${engine}${candidates[0]}`
  })
}

const declared = browserslist.loadConfig({ path: fileURLToPath(new URL('../', import.meta.url)), env: 'production' })
if (! declared?.length)
  throw new Error('Production Browserslist must declare the supported browsers')

export const production_browser_queries = declared
export const production_css_targets = css_targets(declared)
