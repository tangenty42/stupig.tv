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

  it('uses the original line number for ordinary links inside nested carousels', () => {
    const source = ['<carousel>', '', `![适用](${target})`, '', '<carousel>', '```md', `[示例](${target})`, '```', '', `- [误用](${target})`, '</carousel>', '</carousel>'].join('\n')
    expect(warnings(source)).toEqual([
      expect.objectContaining({ line: 10, severity: 'warning' }),
    ])
  })

  it.each([
    ['前文\n\n😀 <carousel title="a > b">', 3],
    ['前文\n\n<carousel\n class="rail"\n title="a > b">', 5],
  ])('finds ordinary video links immediately after the attributed tag %j', (before, line) => {
    const source = `${before}[误用](${target}) ![适用](${target})</carousel> 后文`
    expect(warnings(source)).toEqual([expect.objectContaining({ line, severity: 'warning' })])
  })
})
