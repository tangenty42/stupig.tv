import { expect, it } from 'vitest'
import { content_carousel_plugin, find_content_carousel_close, read_content_carousel_open } from './content-carousel'
import { extract_attachment_names, rename_attachment_references } from './content-markdown'
import { content_carousel_content_ranges, create_content_markdown_parser } from './content-markdown-syntax'
import { has_private_content, redact_private_content, redact_private_content_with_source_map } from './content-private'

it('recognizes an explicit block across blank lines without requiring a preceding blank line', () => {
  const source = 'before\n<carousel>\n![caption](att://a.png)\n\n[site](https://example.com)\n</carousel>\nafter'
  const token = create_content_markdown_parser().parse(source, {}).find(token => token.type === 'content_carousel_block')!
  expect(token.map).toEqual([1, 6])
  expect(token.content).toBe('\n![caption](att://a.png)\n\n[site](https://example.com)\n')
})

it.each(['', '> ', '  '])('maps a carousel body to original UTF-16 offsets with prefix %j', (prefix) => {
  const body = '[😀](att://图片.png)'
  const source = ['<carousel>', body, '</carousel>'].map(line => `${prefix}${line}`).join('\r\n')
  const [range] = content_carousel_content_ranges(source)
  expect(range?.from).toBe(source.indexOf('<carousel>') + '<carousel>'.length)
  expect(range?.to).toBe(source.lastIndexOf('</carousel>'))
  expect(range?.content.trim()).toBe(body)
})

it('finds containers inside private and ordinary HTML wrappers while ignoring code', () => {
  const carousel = '<carousel>\n[😀](att://a.png)\n</carousel>'
  for (const source of [`<good>\n${carousel}\n</good>`, `<div>\n${carousel}\n</div>`, `\`\`\`\n${carousel}\n\`\`\`\n\n${carousel}`]) {
    const ranges = content_carousel_content_ranges(source)
    expect(ranges).toHaveLength(1)
    expect(source.slice(ranges[0]!.from, ranges[0]!.to)).toContain('[😀](att://a.png)')
  }
  expect(content_carousel_content_ranges(carousel.split('\n').map(line => `    ${line}`).join('\n'))).toEqual([])
})

it('keeps attachment uses and shared reference rewrites inside the explicit container', () => {
  const source = '[photo]: att://old.png\n\n<carousel>\n![caption][photo] [](att://notes.txt)\n</carousel>'
  expect(extract_attachment_names(source)).toEqual(['old.png', 'notes.txt'])
  expect(rename_attachment_references(source, 'old.png', 'new.png')).toBe(source.replace('att://old.png', 'att://new.png'))
})

it('finds nested carousel ranges while skipping the same tags in fenced Markdown', () => {
  const source = ['<carousel>', '```md', '<carousel>', '</carousel>', '```', '', '<carousel>', '正文', '</carousel>', '</carousel>'].join('\n')
  const ranges = content_carousel_content_ranges(source)
  expect(ranges.map(range => range.content.trim())).toEqual([source.split('\n').slice(1, - 1).join('\n'), '正文'])
  expect(source.slice(ranges[1]!.from, ranges[1]!.to)).toBe('\n正文\n')
})

it.each([
  '<good>private 😀</good>',
  '<good>\nprivate 😀\n\nprivate rest\n</good>',
  '<GOOD>private 😀</GOOD>',
  '<GoOd>\nprivate 😀\n\nprivate rest\n</gOoD>',
])('redacts private content inside a complete container across blank lines: %s', (private_item) => {
  const source = `<carousel>\n[public](https://example.com)\n${private_item}\n![public](att://public.png)\n</carousel>\n\n# Heading`
  expect(has_private_content(source)).toBe(true)
  const result = redact_private_content_with_source_map(source)
  expect(result.markdown).toBe(redact_private_content(source))
  expect(result.markdown).not.toContain('private 😀')
  expect(result.markdown).not.toContain('private rest')
  expect(result.markdown).toContain('att://public.png')
  const heading = result.markdown.split('\n').indexOf('# Heading')
  expect(result.source_lines?.[heading]).toBe(source.split('\n').indexOf('# Heading'))
})

it('does not treat private examples in fenced code inside a carousel as private source', () => {
  const source = '<carousel>\n```\n<good>example</good>\n```\n</carousel>'
  expect(has_private_content(source)).toBe(false)
  expect(redact_private_content(source)).toBe(source)
})

it.each([
  ['<carousel invalid>', '</carousel>'],
  ['<carousel>', ''],
  ['<CAROUSEL invalid>', ''],
])('keeps private text hidden in complete or unfinished pairs: %s %s', (open, close) => {
  const source = `${open}\n[public](https://example.com)\n<GoOd>\n\nSECRET\n</gOoD>\n![public](att://public.png)\n${close}`
  expect(has_private_content(source)).toBe(true)
  const result = redact_private_content(source)
  expect(result).not.toContain('SECRET')
  expect(result).toContain('[public](https://example.com)')
  expect(result).toContain('att://public.png')
})

it('reads quoted, unquoted and boolean HTML attributes without ending at a quoted >', () => {
  const source = '<CAROUSEL CLASS="one &amp; two" title=plain hidden data-value=\'x > y &quot;yes&quot;\' class="ignored">'
  expect(read_content_carousel_open(source)).toEqual({ end: source.length, attrs: [['class', 'one & two'], ['title', 'plain'], ['hidden', ''], ['data-value', 'x > y "yes"']] })
  expect(read_content_carousel_open('<carousel title="\\* &lt; &#x1f600;">')?.attrs).toEqual([['title', '\\* < 😀']])
  expect(read_content_carousel_open('<carousel\n  title="line\nvalue"\n>')?.attrs).toEqual([['title', 'line\nvalue']])
})

it.each(['<carousel/>', '<carousel />', '<carousel a="unterminated>', '<carousel a=>', '<carousel a="x"b="y">', '<carousels>'])('rejects malformed or self-closing paired open tags: %s', (source) => {
  expect(read_content_carousel_open(source)).toBeNull()
})

it('parses same-line block and in-prose inline pairs with decoded attrs and exact metadata', () => {
  const md = create_content_markdown_parser()
  const block_source = '<carousel class="one" title="x > y">**body**</carousel>'
  const block = md.parse(block_source, {}).find(token => token.type === 'content_carousel_block')!
  expect(block.content).toBe('**body**')
  expect(block.markup).toBe(block_source)
  expect(block.attrs).toEqual([['class', 'one'], ['title', 'x > y']])
  expect(block.meta).toEqual({ body_start: block_source.indexOf('**body**'), body_end: block_source.indexOf('</carousel>'), open_length: block_source.indexOf('**body**'), closed: true })
  const source = 'before <carousel title="a &amp; b">😀 [link](att://a.png)</carousel> after'
  const inline = md.parse(source, {}).flatMap(token => token.children ?? []).find(token => token.type === 'content_carousel_inline')!
  expect(inline.content).toBe('😀 [link](att://a.png)')
  expect(source.slice(inline.meta.body_start, inline.meta.body_end)).toBe(inline.content)
  expect(inline.markup).toBe('<carousel title="a &amp; b">😀 [link](att://a.png)</carousel>')
  expect(inline.meta.open_length).toBe('<carousel title="a &amp; b">'.length)
})

it('keeps same-line siblings inline and preserves trailing prose after a multiline block', () => {
  const md = create_content_markdown_parser()
  const source = '<carousel>one</carousel><carousel>two</carousel>'
  const inline = md.parse(source, {}).flatMap(token => token.children ?? []).filter(token => token.type === 'content_carousel_inline')
  expect(inline.map(token => token.content)).toEqual(['one', 'two'])
  const tokens = md.parse('<carousel>first\n\nsecond</carousel> after\n\nlast', {})
  expect(tokens.find(token => token.type === 'content_carousel_block')?.content).toBe('first\n\nsecond')
  expect(tokens.filter(token => token.type === 'inline').map(token => token.content)).toEqual([' after', 'last'])
})

it.each([
  '`</carousel>`',
  '``text ` </carousel> text``',
  '```md\n</carousel>\n```',
  '~~~md\n<carousel></carousel>\n~~~',
  '- ```md\n  </carousel>\n  ```',
  '- ```md\n    </carousel>\n    ```',
  '> ```md\n> </carousel>\n> ```',
  '```md\n    ```\n</carousel>\n```',
  '    </carousel>',
  '<code>&lt;x&gt; </carousel></code>',
  '<pre>\n</carousel>\n</pre>',
  '<script>const example = "</carousel>"</script>',
  '<!-- </carousel> -->',
  '<span title="</carousel>">kept</span>',
])('matches the outer close while skipping code and raw examples: %s', (example) => {
  const source = `<carousel>\n${example}\n<carousel title="nested > value">nested</carousel>\n</carousel>`
  const open = read_content_carousel_open(source)!
  expect(find_content_carousel_close(source, open.end)).toEqual({ start: source.lastIndexOf('</carousel>'), end: source.length })
  expect(create_content_markdown_parser().parse(source, {})[0]?.markup).toBe(source)
})

it('does not claim carousel examples inside raw inline HTML or Markdown code', () => {
  const md = create_content_markdown_parser()
  for (const source of ['before `<carousel>example</carousel>` after', 'before <code><carousel>example</carousel></code> after', 'before <textarea><carousel>example</carousel></textarea> after', '\\<carousel>escaped</carousel>']) {
    const tokens = md.parse(source, {})
    expect(tokens.some(token => token.type === 'content_carousel_block')).toBe(false)
    expect(tokens.flatMap(token => token.children ?? []).some(token => token.type === 'content_carousel_inline')).toBe(false)
  }
})

it('normalizes Markdown container prefixes while keeping block metadata in the original source', () => {
  const source = '> <carousel title="quote > value">\n> **body**\n> </carousel>'
  const token = create_content_markdown_parser().parse(source, {}).find(token => token.type === 'content_carousel_block')!
  expect(token.content).toBe('\n**body**\n')
  expect(token.meta.body_start).toBe(source.indexOf('\n'))
  expect(token.meta.body_end).toBe(source.indexOf('</carousel>'))
  expect(token.markup).toBe(source.slice(2))
})

it('keeps incomplete opening tags visible to privacy-only recovery', () => {
  const source = '<carousel title="unterminated>\n<good>SECRET</good>'
  const md = create_content_markdown_parser()
  content_carousel_plugin(md, true)
  const token = md.parse(source, {}).find(token => token.type === 'content_carousel_block')!
  expect(token.meta.closed).toBe(false)
  expect(token.content).toContain('<good>SECRET</good>')
})

it('keeps original absolute offsets across consecutive top-level pairs and a list container', () => {
  const source = 'before\n\n<carousel>one</carousel>\n\n  <carousel data-id=two>two\nlines</carousel>\n\n- <carousel>three\n  lines</carousel>'
  const tokens = create_content_markdown_parser().parse(source, {}).filter(token => token.type === 'content_carousel_block')
  expect(tokens.map(token => token.content)).toEqual(['one', 'two\nlines', 'three\nlines'])
  expect(tokens.map(token => token.meta.body_start)).toEqual(['one', 'two', 'three'].map(word => source.indexOf(`>${word}`) + 1))
  for (const token of tokens) {
    expect(source.slice(token.meta.body_start - token.meta.open_length, token.meta.body_start)).toMatch(/^<carousel/)
    expect(source.slice(token.meta.body_end, token.meta.body_end + '</carousel>'.length)).toBe('</carousel>')
  }
})

it.each(['- ```md\n  example', '> ```md\n> example'])('does not let a fence consume tags after its Markdown container ends: %s', (body) => {
  const source = `<carousel>\n${body}\n</carousel>`
  const open = read_content_carousel_open(source)!
  expect(find_content_carousel_close(source, open.end)).toEqual({ start: source.lastIndexOf('</carousel>'), end: source.length })
})
