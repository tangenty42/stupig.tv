import { extract_attachment_names, rename_attachment_references } from '@shared/content-markdown'
import { describe, expect, it } from 'vitest'
import { create_story_markdown } from './index'

function render(source: string, story_exists = false) {
  const md = create_story_markdown({
    story_id: () => 1,
    attachments: () => [{ file_name: 'a.txt', is_image: false, mime_type: 'text/plain', file_size: 1, version: 'v1', url: '/objects/a.txt' }],
    stories: () => story_exists ? [{ id: 2, title: 'Other', labels: [], event_precision: 'day', event_dates: [], created_at: '', updated_at: '', desc: null, cover: null, cover_label: null, cover_version: null, cover_url: null }] : [],
    static_url: path => path,
    folder_card_openable: () => false,
  })
  return md.render(source, { images: [] })
}

describe('story Markdown preset contracts', () => {
  it.each([
    '<script>alert(1)</script>',
    '<iframe src="https://example.test" srcdoc="<script>alert(1)</script>"></iframe>',
    '<img src="https://example.test/image.png" onerror="alert(1)">',
    '<div onclick="alert(1)">static text</div>',
    '<a href="java&#x73;cript:alert(1)">link</a>',
    '<a href="java&#9;script:alert(1)">link</a>',
    '<a href="data:text/html,<script>alert(1)</script>">link</a>',
    '<svg onload="alert(1)"><a xlink:href="javascript:alert(1)">link</a></svg>',
    '<object data="data:text/html,<script>alert(1)</script>"></object>',
    '<embed src="data:text/html,<script>alert(1)</script>">',
    '<meta http-equiv="refresh" content="0;url=javascript:alert(1)">',
    '<div style="background-image:url(javascript:alert(1));width:expression(alert(1))">text</div>',
    '<div>\n<script>alert(1)</script>\n<iframe src="https://example.test"></iframe>\n</div>',
    '<math><mtext><table><mglyph><style><!--</style><img title="--><img src=x onerror=alert(1)>">',
  ])('removes executable HTML and embedded frames: %s', (source) => {
    const html = render(source)
    expect(html).not.toMatch(/<(?:script|iframe|svg|math|object|embed|meta|style)\b/i)
    expect(html).not.toMatch(/\s(?:on\w+|srcdoc)\s*=/i)
    expect(html).not.toMatch(/(?:javascript:|expression\()/i)
  })

  it('preserves static HTML wrappers while removing execution attributes', () => {
    const html = render('<center onclick="alert(1)">\n**safe**\n</center>')
    expect(html).toContain('<center')
    expect(html).toContain('<strong>safe</strong>')
    expect(html).not.toContain('onclick')
  })

  it('also sanitizes the public inline rendering entry point', () => {
    const md = create_story_markdown({
      story_id: () => 1,
      attachments: () => [],
      stories: () => [],
      static_url: path => path,
      folder_card_openable: () => false,
    })
    const html = md.renderInline('<img src="/image.png" onerror="alert(1)"><iframe src="/frame"></iframe><a href="javascript:alert(1)">link</a>')
    expect(html).toContain('src="/image.png"')
    expect(html).not.toMatch(/iframe|onerror|javascript:/i)
  })

  it.each([true, false])('keeps formatted story labels as balanced links (target exists: %s)', (exists) => {
    for (const label of ['**label**', '*label*', '`label`']) {
      const html = render(`[${label}](content://Other)`, exists)
      expect(html).toContain(`href="${exists ? '/content/2' : 'content://Other'}"`)
      expect(html).not.toContain('story-card')
      expect(html).toContain('link-card-label')
      expect(html.match(/<a\b/g)).toHaveLength(1)
      expect(html.match(/<\/a>/g)).toHaveLength(1)
      expect(html.match(/<span\b/g)?.length).toBe(html.match(/<\/span>/g)?.length)
    }
  })
  it('keeps headings, emphasis, deletion, lists, quotes and hard breaks', () => {
    const html = render('# Heading\n\nUnderline\n===\n\n**bold** *emphasis* ~~removed~~  \nnext\n\n- item\n\n1. ordered\n\n> quote\n\n---')
    for (const fragment of ['>Heading</h1>', '>Underline</h1>', '<strong>bold</strong>', '<em>emphasis</em>', '<s>removed</s>', '<br />', '<ul ', '<ol ', '<blockquote ', '<hr '])
      expect(html).toContain(fragment)
  })

  it('escapes code without expanding references or raw HTML', () => {
    const source = '```html extra-info\n<script>[](att://a.txt)</script>\n```\n\n    <b>indented</b>\n\n`[](att://a.txt)`'
    const html = render(source)
    expect(html).toContain('class="language-html"')
    expect(html).toContain('&lt;script&gt;[](att://a.txt)&lt;/script&gt;')
    expect(html).toContain('&lt;b&gt;indented&lt;/b&gt;')
    expect(html).toContain('code-scroll')
    expect(html).not.toContain('href=')
    expect(extract_attachment_names(source)).toEqual([])
    expect(rename_attachment_references(source, 'a.txt', 'b.txt')).toBe(source)
  })

  it('does not linkify bare URLs but renders explicit autolinks and reference links', () => {
    expect(render('https://example.test/path')).not.toContain('<a ')
    expect(render('<https://example.test/path>')).toContain('href="https://example.test/path"')
    expect(render('[label][target]\n\n[target]: https://example.test/path "title"')).toContain('href="https://example.test/path" title="title"')
  })

  it('gives fenced and indented code the same escaped scroll frame and source anchor', () => {
    const fenced = render('```\n<a>& text\n```')
    const indented = render('    <a>& text\n')
    expect(indented).toBe(fenced)
    expect(indented).toBe('<pre data-line="0"><div class="code-scroll"><code>&lt;a&gt;&amp; text\n</code></div></pre>\n')
  })

  it.each(['<good>\nBOOM\n</good>', '<div>\nBOOM\n</div>'])('restores source anchors after a nested render fails: %s', (source) => {
    const md = create_story_markdown({
      story_id: () => 1,
      attachments: () => [],
      stories: () => [],
      static_url: path => path,
      folder_card_openable: () => false,
    })
    const text_rule = md.renderer.rules.text!
    md.renderer.rules.text = (tokens, idx, ... args) => {
      if (tokens[idx]!.content === 'BOOM')
        throw new Error('nested render failed')
      return text_rule(tokens, idx, ... args)
    }
    const env = { images: [] }
    expect(() => md.render(source, env)).toThrow('nested render failed')
    md.renderer.rules.text = text_rule
    expect(md.render('# After', env)).toBe('<h1 data-line="0">After</h1>\n')
  })

  it('renders table row spans, column spans, multiple bodies and captions without generated IDs', () => {
    const html = render('| A | B |\n| :--- | ---: |\n| one | two |\n| ^^ | three |\n\n| merged ||\n[中文标题]')
    expect(html).toContain('rowspan="2"')
    expect(html).toContain('colspan="2"')
    expect(html.match(/<tbody\b/g)).toHaveLength(2)
    expect(html).toContain('text-align:right')
    expect(html).toMatch(/<caption[^>]*>中文标题<\/caption>/)
    expect(html).not.toMatch(/<caption[^>]*\sid=/)
  })

  it.each(['NOTE', 'TIP', 'IMPORTANT', 'WARNING', 'CAUTION'])('renders %s only at the beginning of a quote', (type) => {
    const html = render(`> [!${type}] <custom>\n> **body**`)
    expect(html).toContain(`markdown-alert-${type.toLowerCase()}`)
    expect(html).toContain('&lt;custom&gt;')
    expect(html).toContain('<strong>body</strong>')
    expect(render(`> before\n> [!${type}]`)).not.toContain('markdown-alert-title')
    expect(render(`> [!${type.toLowerCase()}]`)).not.toContain('markdown-alert-title')
  })

  it('renders Markdown in a complete HTML wrapper and follows its attachment reference', () => {
    const source = '<div class="sample">\n    **bold** [](att://a.txt)\n</div>'
    const html = render(source)
    expect(html).toContain('class="sample"')
    expect(html).toContain('<strong>bold</strong>')
    expect(html).toContain('href="/objects/a.txt"')
    expect(extract_attachment_names(source)).toEqual(['a.txt'])
    expect(rename_attachment_references(source, 'a.txt', 'b.txt')).toBe(source.replace('att://a.txt', 'att://b.txt'))
  })

  it('leaves raw HTML tables and code containers unexpanded', () => {
    const table = '<table><tr><td>**raw**</td></tr></table>'
    expect(render(table)).toContain(table)
    const raw = '<pre>**raw** [](att://a.txt)</pre>'
    expect(render(raw)).toContain(raw)
    expect(extract_attachment_names(raw)).toEqual([])
    expect(rename_attachment_references(raw, 'a.txt', 'b.txt')).toBe(raw)
  })

  it('does not introduce task checkboxes, math or diagram execution', () => {
    const html = render('- [x] done\n\n$x^2$\n\n```mermaid\ngraph TD; A-->B\n```')
    expect(html).toContain('[x] done')
    expect(html).not.toContain('<input')
    expect(html).toContain('$x^2$')
    expect(html).toContain('class="language-mermaid"')
    expect(html).toContain('graph TD; A--&gt;B')
    expect(html).not.toContain('<svg')
  })
})
