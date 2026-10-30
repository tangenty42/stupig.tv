import { beforeAll, describe, expect, it } from 'vitest'
import { probe_css_cascade_feasibility } from './css-cascade-feasibility'

describe('installed CSS integration entry points', () => {
  let result: Awaited<ReturnType<typeof probe_css_cascade_feasibility>>

  beforeAll(async () => {
    result = await probe_css_cascade_feasibility()
  })

  it('observes constructor-local selector finishing without splitting declarations', () => {
    expect(result.codemirror.finish_calls).toBe(1)
    expect(result.codemirror.manual_css).toContain(':not(#cascade-probe-guard)')
    expect(result.codemirror.manual_css).toContain('color: red; display: none !important;')
    expect(result.codemirror.project_theme_css).toHaveLength(1)
    expect(result.codemirror.project_theme_css[0]).not.toContain('cascade-probe-guard')
  })

  it('observes additive style providers rather than replacement of existing modules', () => {
    expect(result.codemirror.facet_module_count).toBeGreaterThan(1)
    expect(result.codemirror.additive_facet_module_count).toBe(result.codemirror.facet_module_count + 1)
  })

  it('observes PrimeVue update notifications after the raw CSS is already written', () => {
    expect(result.primevue.observed_updates).toEqual([
      '.cascade-probe { color: red }',
      '.cascade-probe { color: blue }',
    ])
    expect(result.primevue.base_ssr_has_style_element).toBe(true)
    expect(result.primevue.base_ssr_bytes).toBeGreaterThan(0)
    expect(result.primevue.theme_ssr_bytes).toBeGreaterThan(0)
  })
})
