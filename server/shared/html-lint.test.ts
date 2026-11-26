import { describe, expect, it } from 'vitest'
import { build_html_diagnostics, html_lint_line } from './html-lint'

function messages(doc: string) {
  return build_html_diagnostics(doc).map(d => d.message)
}

describe('build_html_diagnostics', () => {
  it('accepts plain markdown without HTML', () => {
    expect(build_html_diagnostics('hello\n\nworld **bold**\n')).toEqual([])
  })

  it('accepts well-formed block and inline HTML', () => {
    expect(messages('a\n\n<div>\nx\n</div>\n\nb <span>y</span> c\n')).toEqual([])
  })

  it('reports an unclosed block element', () => {
    expect(messages('a\n\n<div>\nx\n')).toEqual(['缺少闭合标签 </div>'])
  })

  it('reports a mismatched close tag with the expected name', () => {
    expect(messages('<div>\nx\n</span>\n'))
      .toEqual(['闭合标签 </span> 与 <div> 不匹配，应为 </div>'])
  })

  it('reports a stray close tag as extra', () => {
    expect(messages('text </span>\n')).toEqual(['多余的闭合标签 </span>'])
  })

  it('keeps a wrapper split by blank lines in one region', () => {
    expect(messages('<center>\n\nx\n\n</center>\n')).toEqual([])
    expect(messages('<center>\n\nx\n')).toEqual(['缺少闭合标签 </center>'])
  })

  it('checks actual carousel delimiters while leaving the immediate code fence alone', () => {
    const source = ['<carousel>', '```html', '</carousel>', '<div>', '```', '<carousel>', '正文', '</carousel>'].join('\n')
    expect(messages(`${source}\n</carousel>`)).toEqual([])
    expect(messages(source)).toEqual(['缺少闭合标签 </carousel>'])
  })

  it('ignores carousel code tags even inside a private wrapper', () => {
    const before = ['<good>', '<carousel>', '```html', '</carousel>', '<div>', '```', '</carousel>', '</good>'].join('\n')
    expect(messages(before)).toEqual([])
    const source = `${before}\n\n<em>`
    const [diagnostic] = build_html_diagnostics(source)
    expect(diagnostic?.message).toBe('缺少闭合标签 </em>')
    expect(source.slice(diagnostic!.from, diagnostic!.to)).toBe('em')
  })

  it('checks inline carousel closures at original offsets after attributes and code', () => {
    const source = '😀 前文 <carousel title="a > b">`</carousel>` **正文**'
    expect(messages(`${source}</carousel> 后文`)).toEqual([])
    expect(messages('<div><carousel title="a > b">`</carousel>`</carousel></div>')).toEqual([])
    const [diagnostic] = build_html_diagnostics(source)
    expect(diagnostic?.message).toBe('缺少闭合标签 </carousel>')
    expect(diagnostic?.from).toBe(source.indexOf('carousel'))
    expect(source.slice(diagnostic!.from, diagnostic!.to)).toBe('carousel')
    expect(messages(`${source}</span>`)).toEqual(['闭合标签 </span> 与 <carousel> 不匹配，应为 </carousel>'])
  })

  it('ignores code tags in a fence directly after an attributed carousel tag', () => {
    const source = ['<carousel title="a > b">', '```html', '</carousel>', '<div>', '```', '</carousel>'].join('\n')
    expect(messages(source)).toEqual([])
  })

  describe('private (good) elements', () => {
    // `<good>` is a plain custom element, so private tags lint like any
    // other element with no special handling.
    it('accepts a closed inline private element', () => {
      expect(messages('before <good>222</good> after\n')).toEqual([])
    })

    it('accepts a closed block private element', () => {
      expect(messages('a\n\n<good>\nx\n</good>\n\nb\n')).toEqual([])
    })

    it('reports an unclosed block private element', () => {
      expect(messages('a\n\n<good>\nx\n')).toEqual(['缺少闭合标签 </good>'])
    })

    it('reports an unclosed inline private element', () => {
      expect(messages('before <good>222\n')).toEqual(['缺少闭合标签 </good>'])
    })

    it('reports a mismatched close on a private element', () => {
      expect(messages('<good>\nx\n</span>\n'))
        .toEqual(['闭合标签 </span> 与 <good> 不匹配，应为 </good>'])
    })

    it('keeps diagnostics offsets aligned with the original document', () => {
      const doc = 'before <good>222\n'
      const [diagnostic] = build_html_diagnostics(doc)
      // The reported range must point at `good` in the ORIGINAL text.
      expect(doc.slice(diagnostic!.from, diagnostic!.to)).toBe('good')
    })
  })
})

describe('html_lint_line', () => {
  it('maps an offset to its 1-based line number', () => {
    const doc = 'one\ntwo\nthree\n'
    expect(html_lint_line(doc, 0)).toBe(1)
    expect(html_lint_line(doc, 4)).toBe(2)
    expect(html_lint_line(doc, 8)).toBe(3)
  })
})
