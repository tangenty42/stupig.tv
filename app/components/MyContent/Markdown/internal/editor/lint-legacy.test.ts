import { Text } from '@codemirror/state'
import { expect, it, vi } from 'vitest'

it('loads the real lint entry without native Segmenter and retains Unicode graphemes and diagnostics', async () => {
  const native_intl = Intl
  const native_segmenter = Intl.Segmenter
  // Substitute only the missing platform API; all diagnostics dependencies
  // and the application's import ordering run unchanged.
  const legacy_intl = Object.defineProperties({}, {
    ... Object.getOwnPropertyDescriptors(Intl),
    Segmenter: { value: undefined, configurable: true, writable: true },
  })
  vi.stubGlobal('Intl', legacy_intl)
  try {
    const { build_diagnostics, story_lint_config } = await import('./lint')
    expect(typeof Intl.Segmenter).toBe('function')
    expect([... new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment('中e\u0301👨‍👩‍👧‍👦')].map(item => item.segment))
      .toEqual(['中', 'e\u0301', '👨‍👩‍👧‍👦'])
    const source = '#Missing space\n'
    const config = story_lint_config({ titleMaxLength: 100, labelMaxBytes: 100, descMaxBytes: 100, coverMaxBytes: 100, markdownMaxBytes: 10000 }, [], null)
    const diagnostics = build_diagnostics(source, Text.of(source.split('\n')), config)
    expect(diagnostics).toContainEqual(expect.objectContaining({ source: 'MD018' }))
    expect(native_intl.Segmenter).toBe(native_segmenter)
  }
  finally {
    vi.unstubAllGlobals()
  }
})
