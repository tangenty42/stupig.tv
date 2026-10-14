import { describe, expect, it } from 'vitest'
import { content_reference_dialect } from './content-dialect'
import { extract_attachment_names, extract_story_reference_titles, lint_content_refs, parse_story_markdown, rewrite_content_refs, upgrade_legacy_refs } from './content-markdown'
import { format_attachment_ref, format_story_ref, parse_content_ref } from './content-reference'

const config = {
  title_max_length: 60, label_max_bytes: 255, desc_max_bytes: 500, cover_max_bytes: 255, markdown_max_bytes: 1048576,
  existing_titles: [{ id: 2, title: '其他档案' }], attachment_paths: ['图片/a.png', 'cards', 'cover.jpg'],
}
const document = (body: string) => `---\ntitle: 本篇\ntime: 2026/10/14\n---\n${body}`

describe('content reference dialect', () => {
  it.each([
    ['att://图片/a.png', { kind: 'attachment', path: '图片/a.png' }],
    ['att://%E5%9B%BE%E7%89%87/a.png', { kind: 'attachment', path: '图片/a.png' }],
    ['att://cards/', { kind: 'attachment', path: 'cards' }],
    ['content://其他档案', { kind: 'story', title: '其他档案' }],
    ['@其他档案', { kind: 'legacy_story', title: '其他档案' }],
    ['图片/a.png', { kind: 'legacy_attachment', path: '图片/a.png' }],
  ])('parses %s without treating a path segment as a host', (destination, expected) => {
    expect(parse_content_ref(destination)).toEqual(expected)
  })
  it.each(['att:///a', 'att://a//b', 'att://', 'att://a//', 'att://a%20b', 'att://a%ZZ', 'content://a/b', 'content://', 'ATT://a', 'Content://b', '#a', 'https://example.test', 'mailto:a@b', '/absolute'])('rejects invalid or unrelated destinations: %s', (destination) => {
    expect(parse_content_ref(destination)).toBeNull()
  })
  it('formats all registered constructs consistently', () => {
    expect(Object.keys(content_reference_dialect)).toEqual(['attachment_ref', 'folder_ref', 'story_ref'])
    for (const item of Object.values(content_reference_dialect)) {
      expect(item.markdown).toBe(`[](${item.format(item.example)})`)
      expect(parse_content_ref(item.format(item.example))).not.toBeNull()
    }
    expect(format_attachment_ref('cards/')).toBe('att://cards')
    expect(format_story_ref('其他档案')).toBe('content://其他档案')
  })
  it('extracts nested, angle-wrapped and percent-encoded targets, excluding code and raw HTML', () => {
    const markdown = '![alt [](att://docs/a.pdf)](<att://%E5%9B%BE%E7%89%87/a.png> "标题") [](content://其他档案)\n'
      + '`[](att://inline)`\n```md\n[](att://fenced)\n```\n    [](att://indented)\n'
      + '<a href="[](att://attribute)">link</a><!-- [](att://comment) -->\n<pre>[](att://pre)</pre>'
    expect(extract_attachment_names(markdown)).toEqual(['图片/a.png', 'docs/a.pdf'])
    expect(extract_story_reference_titles(markdown)).toEqual(['其他档案'])
  })
  it('converts legacy syntax once and preserves external targets, labels, code and HTML', () => {
    const before = document('![alt [](docs/a.pdf)](<图片/a.png> "标题") [](@其他档案) [](https://example.test) [](#a) [](mailto:a@b)\n`[](x)`\n<a href="x">[](docs/a.pdf)</a>\n<pre>[](x)</pre>')
    const after = document('![alt [](att://docs/a.pdf)](<att://图片/a.png> "标题") [](content://其他档案) [](https://example.test) [](#a) [](mailto:a@b)\n`[](x)`\n<a href="x">[](att://docs/a.pdf)</a>\n<pre>[](x)</pre>')
    expect(upgrade_legacy_refs(before)).toBe(after)
    expect(upgrade_legacy_refs(after)).toBe(after)
    expect(upgrade_legacy_refs('---\ncover: cover.jpg\n---')).toBe('---\ncover: att://cover.jpg\n---')
  })
  it('keeps indented Markdown inside supported HTML wrappers and resumes after void HTML elements', () => {
    const source = '<div>\n    [](inside.png)\n</div>\n\n<embed src="external">\n\n[](outside.png)'
    expect(upgrade_legacy_refs(source)).toBe('<div>\n    [](att://inside.png)\n</div>\n\n<embed src="external">\n\n[](att://outside.png)')
    expect(extract_attachment_names(source)).toEqual(['inside.png', 'outside.png'])
  })
  it('rewrites a batch simultaneously, including folder roots, descendants, cover and default labels', () => {
    const markdown = '---\ncover: ![](att://X/n)\n---\n[X/n](att://X/n) [](att://Y/n) [](att://X) ![alt [](att://X/n)](att://X/img.png)'
    const steps = [{ attachments: [{ from: 'X', to: 'Y', is_folder: true }, { from: 'Y', to: 'Z', is_folder: true }] }]
    expect(rewrite_content_refs(markdown, steps)).toBe('---\ncover: ![](att://Y/n)\n---\n[Y/n](att://Y/n) [](att://Z/n) [](att://Y) ![alt [](att://Y/n)](att://Y/img.png)')
    expect(rewrite_content_refs('[](att://X/n)', [steps[0]!, { attachments: [{ from: 'Y', to: 'Z', is_folder: true }] }])).toBe('[](att://Z/n)')
    expect(rewrite_content_refs('---\ncover: att://X/n\n---', steps)).toBe('---\ncover: att://Y/n\n---')
  })
  it('rewrites exact files and title chains with the same case-insensitive title comparison', () => {
    expect(rewrite_content_refs('[a](att://a) [a](att://b)', [{ attachments: [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }] }])).toBe('[b](att://b) [a](att://c)')
    const steps = [{ stories: [{ from: 'A', to: 'B' }] }, { stories: [{ from: 'b', to: 'C' }] }]
    expect(rewrite_content_refs('[a](content://a)', steps)).toBe('[C](content://C)')
    expect(rewrite_content_refs('[](att://a)', [{ attachments: [{ from: 'a', to: 'b' }] }, { attachments: [{ from: 'a', to: 'b' }] }])).toBe('[](att://b)')
  })
  it('keeps cover storage and byte limits free of the scheme', () => {
    const parsed = parse_story_markdown('---\ntitle: 本篇\ntime: 2026/10/14\ncover: ![](att://cover.jpg)\n---', { ... config, cover_max_bytes: 9 })
    expect(parsed.meta?.cover).toBe('cover.jpg')
    expect(parsed.issues).toEqual([])
  })
  it('reports missing attachments as warnings and bad/self/dead story references as errors', () => {
    const issues = parse_story_markdown(document('[](att://gone) [](content://其他档案) [](content://本篇) [](content://不存在) [](content://a/b)'), config).issues
    expect(issues.map(item => [item.severity, item.message])).toEqual([
      ['warning', '附件『gone』不存在'], ['error', '不允许自我引用'], ['error', '档案『不存在』不可引用'], ['error', '档案引用标题不合法，不能包含 /'],
    ])
  })
  it('provides exact quick fix ranges, and lists legacy line numbers after compatibility is disabled', () => {
    const markdown = document('[](ATT://cards)\n[](cards) [](content://其他档案)\n[](@其他档案)')
    const issues = lint_content_refs(markdown, { ... config, legacy_compat: false })
    const uppercase = issues.find(item => item.fix?.insert === 'att://cards')!
    expect(markdown.slice(uppercase.fix!.from, uppercase.fix!.to)).toBe('ATT://cards')
    expect(issues.filter(item => item.source === 'legacy-ref').map(item => item.line)).toEqual([6, 7])
    expect(issues.filter(item => item.source === 'legacy-ref').every(item => item.fix)).toBe(true)
  })
})
