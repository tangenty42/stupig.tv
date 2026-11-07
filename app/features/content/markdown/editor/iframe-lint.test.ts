import { Text } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import { iframe_link_diagnostics } from './iframe-lint'

const target = 'iframe://player.bilibili.com/player.html?bvid=BV1Pvnd6JEVD'
function warnings(source: string) {
  const doc = Text.of(source.split('\n'))
  return iframe_link_diagnostics(source, doc).map(item => ({ ... item, line: doc.lineAt(item.from).number }))
}

describe('iframe dialect diagnostics', () => {
  it('warns at ordinary links and ignores images and code', () => {
    expect(warnings(`![video](${target})\n[video](${target})\n\`[code](${target})\``)).toEqual([
      expect.objectContaining({ line: 2, severity: 'warning', source: 'outer-refs' }),
    ])
  })

  it('distinguishes image and link uses of the same reference definition', () => {
    expect(warnings(`![video][v]\n\n[v]: ${target}`)).toEqual([])
    expect(warnings(`![video][v]\n[video][v]\n\n[v]: ${target}`)).toEqual([
      expect.objectContaining({ line: 2, severity: 'warning' }),
    ])
  })

  it('checks Markdown inside HTML wrappers while ignoring raw code containers', () => {
    expect(warnings(`<div>\n  [video](${target})\n</div>\n\n<pre>\n[code](${target})\n</pre>`)).toEqual([
      expect.objectContaining({ line: 2, severity: 'warning' }),
    ])
  })
})
