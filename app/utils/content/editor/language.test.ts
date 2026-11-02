import { syntaxTree } from '@codemirror/language'
import { EditorState } from '@codemirror/state'
import { classHighlighter, highlightTree } from '@lezer/highlight'
import { content_ref_changes, extract_attachment_names, rewrite_content_refs, strip_front_matter } from '@shared/content-markdown'
import { expect, it } from 'vitest'
import { create_story_markdown } from '../markdown'
import { editor_markdown_lang } from './language'
import { build_diagnostics, story_lint_config } from './lint'

const metadata = '---\ntitle: 语法测试\ntime: 2026/11/02\n---\n\n'
const table = '[表格说明]\n| 分类 | 合并标题 ||\n| 名称 | 说明 | 文件 |\n| --- | :===: | ---: |\n| 一 | **中文😀** ||\n| ^^ | `a|b` | [自定义](att://old.txt?download=1#part) |\n\n| 二 | 转义\\|符号 | 正常 |'
const md = create_story_markdown({ story_id: () => 1, attachments: () => [{ file_name: 'old.txt', mime_type: 'text/plain', is_image: false, file_size: 1, version: 'v1', url: '/objects/file' }],
  stories: () => [], static_url: path => path, folder_card_openable: () => false })
const config = story_lint_config({ titleMaxLength: 100, labelMaxBytes: 100, descMaxBytes: 100, coverMaxBytes: 100, markdownMaxBytes: 10000 }, [], null,
  [{ file_name: 'old.txt', mime_type: 'text/plain', is_image: false, file_size: 1, version: 'v1', url: '/objects/file' }])

function parse(source: string) {
  const state = EditorState.create({ doc: source, extensions: [editor_markdown_lang] })
  const tree = syntaxTree(state)
  const nodes: { name: string, from: number, to: number, text: string }[] = []
  // Overlay languages are reached through resolveInner, not the outer cursor.
  const seen = new Set<string>()
  for (let pos = 0; pos <= state.doc.length; pos ++) {
    for (let node = tree.resolveInner(pos, 1); node; node = node.parent!) {
      const key = `${node.name}:${node.from}:${node.to}`
      if (! seen.has(key)) {
        seen.add(key)
        nodes.push({ name: node.name, from: node.from, to: node.to, text: state.sliceDoc(node.from, node.to) })
      }
    }
  }
  return { state, tree, nodes }
}

it('recognizes both Setext levels without turning metadata or separated rules into headings', () => {
  const source = `${metadata}一级 *标题*\n===\n\n二级标题\n---\n\n---\n\n正文\n`
  const { nodes, tree } = parse(source)
  expect(nodes.filter(node => node.name === 'FrontMatter')).toHaveLength(1)
  expect(nodes.filter(node => node.name.startsWith('SetextHeading')).map(node => node.text)).toEqual(['一级 *标题*\n===', '二级标题\n---'])
  expect(nodes.filter(node => node.name === 'HorizontalRule')).toHaveLength(1)
  const highlighted: string[] = []
  highlightTree(tree, classHighlighter, (from, to, classes) => {
    if (classes.includes('tok-heading'))
      highlighted.push(source.slice(from, to))
  })
  expect(highlighted.join('')).toContain('二级标题')
  expect(highlighted.join('')).not.toContain('time:')
  const html = md.render(strip_front_matter(source))
  expect(html).toMatch(/<h1\b[^>]*>一级 <em>标题<\/em><\/h1>/)
  expect(html).toMatch(/<h2\b[^>]*>二级标题<\/h2>/)
})

it.each([
  ['root', (body: string) => body, 2],
  ['blockquote', (body: string) => body.split('\n').map(line => `> ${line}`).join('\n'), 2],
  ['HTML wrapper', (body: string) => `<div>\n${body.replace('\n\n', '\n')}\n</div>`, 1],
  ['private wrapper', (body: string) => `<good>\n${body}\n</good>`, 2],
  ['private wrapper with opening text', (body: string) => `<good>开头文字\n\n${body}\n</good>`, 2],
])('shares extended table boundaries and inline syntax with the renderer in %s', (_name, wrap, bodies) => {
  const source = `${metadata + wrap(table)}\n\n正文\n`
  const { state, nodes } = parse(source)
  expect(nodes.filter(node => node.name === 'Table')).toHaveLength(1)
  expect(nodes.filter(node => node.name === 'TableHeader')).toHaveLength(2)
  expect(nodes.filter(node => node.name === 'TableRow')).toHaveLength(3)
  expect(nodes.find(node => node.name === 'TableCaption')?.text).toContain('表格说明')
  expect(nodes.find(node => node.name === 'InlineCode')?.text).toBe('`a|b`')
  expect(nodes.find(node => node.name === 'Link')?.text).toBe('[自定义](att://old.txt?download=1#part)')
  expect(nodes.find(node => node.name === 'Table')?.text).not.toContain('正文')
  const html = md.render(strip_front_matter(source))
  expect(html).toContain('<table')
  expect(html).toContain('colspan="2"')
  expect(html).toContain('rowspan="2"')
  expect(html.match(/<tbody\b/g)).toHaveLength(bodies)
  expect(html).toContain('表格说明')
  const diagnostics = build_diagnostics(source, state.doc, config)
  expect(diagnostics.filter(item => item.severity === 'error' || item.source?.startsWith('MD05'))).toEqual([])
  const next = rewrite_content_refs(source, [{ attachments: [{ from: 'old.txt', to: 'new.txt' }] }])
  expect(next).toBe(source.replace('att://old.txt?', 'att://new.txt?'))
  const changes = content_ref_changes(source, next)
  expect(state.update({ changes }).state.doc.toString()).toBe(next)
})

it('keeps code and raw HTML outside the table grammar', () => {
  for (const body of [`\`\`\`md\n${table}\n\`\`\``, `<pre>\n${table}\n</pre>`, '<!--\n| a | b |\n| - | - |\n-->']) {
    const source = metadata + body
    expect(parse(source).nodes.filter(node => node.name === 'Table')).toEqual([])
    expect(md.render(strip_front_matter(source))).not.toContain('<table')
  }
  const raw = `${metadata}<table><tr><td>\n普通文字\n---\n</td></tr></table>`
  expect(parse(raw).nodes.some(node => node.name.startsWith('SetextHeading'))).toBe(false)
  expect(md.render(strip_front_matter(raw))).not.toContain('<h2')
})

it.each([
  '> 嵌套标题\n> ---',
  '<div>\n嵌套标题\n---\n</div>',
  '<good>\n嵌套标题\n---\n</good>',
])('recognizes nested Setext headings using the same container boundary: %s', (body) => {
  expect(parse(metadata + body).nodes.filter(node => node.name === 'SetextHeading2')).toHaveLength(1)
  expect(md.render(body)).toMatch(/<h2\b[^>]*>嵌套标题<\/h2>/)
})

it('does not diagnose valid column spans as malformed ordinary tables', () => {
  const source = `${metadata}| A | B | C |\n| --- | --- | --- |\n| joined || [说明](att://old.txt) |\n`
  const { state, nodes } = parse(source)
  expect(nodes.filter(node => node.name === 'Table')).toHaveLength(1)
  expect(md.render(strip_front_matter(source))).toContain('colspan="2"')
  expect(build_diagnostics(source, state.doc, config).filter(item => item.source === 'MD056')).toEqual([])
})

it('recognizes ordinary tables after prose and captions after the final row', () => {
  const body = '说明\n| A | B |\n| --- | --- |\n| 一 | 二 |\n[尾部说明][table-id]\n\n正文'
  const source = metadata + body
  const { nodes } = parse(source)
  expect(nodes.filter(node => node.name === 'Table')).toHaveLength(1)
  expect(nodes.find(node => node.name === 'TableCaption')?.text).toBe('[尾部说明][table-id]')
  expect(md.render(body)).toContain('<caption')
})

it.each([false, true])('keeps prose separate from multirow table headers without a blank line (quote=%s)', (quote) => {
  const body = `前文 **粗体**\n${table}`
  const source = metadata + (quote ? body.split('\n').map(line => `> ${line}`).join('\n') : body)
  const { nodes } = parse(source)
  expect(nodes.filter(node => node.name === 'Table')).toHaveLength(1)
  expect(nodes.filter(node => node.name === 'TableHeader')).toHaveLength(2)
  expect(nodes.find(node => node.name === 'Table')?.text).not.toContain('前文')
  expect(nodes.find(node => node.name === 'Paragraph')?.text).toBe('前文 **粗体**')
  expect(md.render(strip_front_matter(source))).toContain('<table')
})

it.each([
  '<good>[说明][p]</good>',
  '前文 <good>[说明][p]</good> 后文',
  '<good>\n\n[说明][p]\n\n</good>',
  '<good>\n\n<good>[说明][p]</good>\n\n</good>',
])('keeps live definitions and rewrites inside private content: %s', (body) => {
  const source = `${metadata + body}\n\n[p]: att://old.txt?q=1#x\n`
  expect(extract_attachment_names(source)).toContain('old.txt')
  const next = rewrite_content_refs(source, [{ attachments: [{ from: 'old.txt', to: 'new.txt' }] }])
  expect(next).toBe(source.replace('att://old.txt?', 'att://new.txt?'))
})

it('invalidates table/header boundaries on edits and preserves UTF-16 link positions', () => {
  const before = `${metadata}| A | B |\n| --- | --- |\n| 😀 | [说明](att://old.txt?q=1#x) |\n\n尾声\n---`
  const { state, nodes } = parse(before)
  const link = nodes.find(node => node.name === 'Link')!
  expect(state.sliceDoc(link.from, link.to)).toBe('[说明](att://old.txt?q=1#x)')
  const from = before.indexOf('| --- | --- |')
  const broken = state.update({ changes: { from, to: from + 13, insert: '| bad | bad |' } }).state
  expect(syntaxTree(broken).toString()).not.toContain('Table(')
  const repaired = broken.update({ changes: { from, to: from + 13, insert: '| --- | --- |' } }).state
  expect(syntaxTree(repaired).toString()).toContain('Table(')
  expect(syntaxTree(repaired).toString()).toContain('SetextHeading2')
})
