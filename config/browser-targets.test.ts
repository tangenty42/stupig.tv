import { describe, expect, it } from 'vitest'
import { css_targets, production_browser_queries, production_css_targets } from './browser-targets'

describe('production browser targets', () => {
  it('retains the declared floor of all four supported engines', () => {
    expect(production_browser_queries).toHaveLength(4)
    expect(production_css_targets).toEqual(['chrome80', 'edge80', 'firefox78', 'safari13.1'])
  })

  it('compares numeric versions and retains Safari minor versions', () => {
    expect(css_targets(['chrome 100', 'chrome 99', 'safari 13.1', 'safari 14'])).toEqual(['chrome99', 'safari13.1'])
  })

  it('rejects an unmapped engine instead of claiming it was covered', () => {
    expect(() => css_targets(['ie 11'])).toThrow('Unsupported CSS browser target')
  })
})
