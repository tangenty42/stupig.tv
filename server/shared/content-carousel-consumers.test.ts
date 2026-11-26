import { expect, it } from 'vitest'
import { content_ref_changes, extract_attachment_names, rename_attachment_references } from './content-markdown'
import { content_carousel_content_ranges } from './content-markdown-syntax'
import { has_private_content, redact_private_content, redact_private_content_with_source_map } from './content-private'

const wrappers = [
  (body: string) => `<carousel title='x'>${body}</carousel>`,
  (body: string) => `before <carousel title="a > b">${body}</carousel> after`,
  (body: string) => `<carousel title='outer'><carousel title="inner">${body}</carousel></carousel>`,
  (body: string) => `<carousel title='x'>\n${body}\n</carousel>`,
  (body: string) => `> <carousel title='x'>\r\n> ${body}\r\n> </carousel>`,
  (body: string) => `- item\n\n  <carousel title='x'>\r\n  ${body}\r\n  </carousel>`,
]

it.each(wrappers)('maps inline and block container contents to their original UTF-16 positions: %#', (wrap) => {
  const body = '[😀](att://图.png)'
  const source = wrap(body)
  const range = content_carousel_content_ranges(source).find(range => range.content.trim() === body)!
  expect(range).toBeDefined()
  const at = range.content.indexOf(body)
  expect(range.offsets).toHaveLength(range.content.length + 1)
  expect(range.offsets[at]).toBe(source.indexOf(body))
  expect(range.offsets[at + body.length]).toBe(source.indexOf(body) + body.length)
  expect(source.slice(range.from, range.to)).toContain(body)
})

it.each(wrappers)('redacts private contents while preserving public surroundings and source anchors: %#', (wrap) => {
  const source = `${wrap('<good>SECRET 😀</good>')}\n\n# Public heading`
  expect(has_private_content(source)).toBe(true)
  const public_view = redact_private_content_with_source_map(source)
  expect(public_view.markdown).toBe(redact_private_content(source))
  expect(public_view.markdown).not.toContain('SECRET')
  expect(public_view.markdown).toContain('你无权查看此处的机密内容')
  expect(public_view.markdown.startsWith(source.slice(0, source.indexOf('<good>')))).toBe(true)
  expect(public_view.source_lines?.[public_view.markdown.split('\n').indexOf('# Public heading')]).toBe(source.split('\n').indexOf('# Public heading'))
})

it.each([
  (body: string) => `<carousel title="ignored [](att://old.txt) [p]">${body}</carousel>`,
  (body: string) => `前缀😀 <carousel title="ignored [](att://old.txt) [p]">${body}</carousel> tail`,
  (body: string) => `<carousel><carousel title="ignored [](att://old.txt) [p]">${body}</carousel></carousel>`,
])('tracks inline and defined references without rewriting attribute text: %#', (wrap) => {
  const source = `${wrap('[](att://old.txt) [shared][p]')}\n\n[p]: <att://shared.txt> 'keep title'`
  expect(extract_attachment_names(source).sort()).toEqual(['old.txt', 'shared.txt'])
  const next = rename_attachment_references(source, 'old.txt', 'new.txt')
  expect(next).toBe(`${wrap('[](att://new.txt) [shared][p]')}\n\n[p]: <att://shared.txt> 'keep title'`)
  const changes = content_ref_changes(source, next)
  expect(changes).toHaveLength(1)
  expect(changes[0]!.from).toBe(source.lastIndexOf('[](att://old.txt)'))
  expect(source.slice(changes[0]!.from, changes[0]!.to)).toBe('[](att://old.txt)')
  expect(rename_attachment_references(source, 'shared.txt', 'next.txt')).toBe(source.replace('att://shared.txt', 'att://next.txt'))
})

it.each(['', '> ', '  '])('maps definitions inside attributed containers with prefix %j and CRLF', (prefix) => {
  const source = ['<carousel title=\'😀 > quoted\'>', '[p]: <att://old.txt> "keep"', '', '[label][p]', '</carousel>'].map(line => prefix + line).join('\r\n')
  expect(extract_attachment_names(source)).toEqual(['old.txt'])
  const next = rename_attachment_references(source, 'old.txt', 'new.txt')
  expect(next).toBe(source.replace('att://old.txt', 'att://new.txt'))
  const [change] = content_ref_changes(source, next)
  expect(source.slice(change!.from, change!.to)).toBe('att://old.txt')
})

it.each(['</good>', '<good>', '<good>attribute text</good>'])('ignores private delimiters inside carousel attributes when closing a real private element: %s', (attribute) => {
  for (const source of [
    `<good><carousel title="${attribute}">SECRET</carousel></good> public tail`,
    `before <good><carousel title="${attribute}">SECRET</carousel></good> public tail`,
    `<good>\n<carousel title="${attribute}">\nSECRET\n</carousel>\n</good>\npublic tail`,
  ]) {
    expect(has_private_content(source)).toBe(true)
    expect(redact_private_content(source)).not.toContain('SECRET')
    expect(redact_private_content(source)).toContain('public tail')
  }
})

it.each([
  '<carousel title="<good>attribute text</good>">public body</carousel>',
  '<div>\n<carousel title="<good>attribute text</good>">public body</carousel>\n</div>',
])('keeps attribute text literal rather than treating it as private Markdown: %s', (source) => {
  expect(has_private_content(source)).toBe(false)
  expect(redact_private_content(source)).toBe(source)
})

it.each([
  '`<carousel title="x"><good>example</good>[p]</carousel>`\n\n[p]: att://unused.txt',
  '```md\n<carousel title="x"><good>example</good>[p]</carousel>\n```\n\n[p]: att://unused.txt',
])('does not expose carousel examples in code to private, reference or drop-range consumers: %s', (source) => {
  expect(has_private_content(source)).toBe(false)
  expect(redact_private_content(source)).toBe(source)
  expect(content_carousel_content_ranges(source)).toEqual([])
  expect(extract_attachment_names(source)).toEqual([])
  expect(rename_attachment_references(source, 'unused.txt', 'changed.txt')).toBe(source)
})
