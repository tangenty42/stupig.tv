import { Text } from '@codemirror/state'
import { private_cover_error_message } from '@shared/content-markdown'
import { expect, it } from 'vitest'
import { build_diagnostics, story_lint_config } from './lint'

const limits = { titleMaxLength: 100, labelMaxBytes: 100, descMaxBytes: 100, coverMaxBytes: 100, markdownMaxBytes: 10000 }
const config = story_lint_config(limits, [], null)

it('groups story, attachment and iframe diagnostics under outer-refs', () => {
  const source = [
    '---',
    'title: 测试',
    'time: 2026/1/1',
    '---',
    '[](content://不存在)',
    '[](att://missing.png)',
    '[视频](iframe://player.bilibili.com/player.html?bvid=BV1Pvnd6JEVD)',
  ].join('\n')
  const doc = Text.of(source.split('\n'))
  const diagnostics = build_diagnostics(source, doc, config)
  for (const message of ['档案『不存在』不可引用', '附件『missing.png』不存在', 'iframe:// 只能用于图片语法 ![标题](iframe://...)']) {
    expect(diagnostics).toContainEqual(expect.objectContaining({ source: 'outer-refs', severity: 'warning', message }))
  }
})

const photo = { mime_type: 'image/png', file_size: 1024, version: 'v1', is_image: true, url: null }
const cover_config = story_lint_config(limits, [], 1, [
  { ... photo, file_name: 'Portrait.png.good', is_private: true },
  { ... photo, file_name: 'Vault.good/É.png', is_private: true },
  { ... photo, file_name: 'Vault.good/Public.png.good', is_private: true },
  { ... photo, file_name: 'Vault.good/Public.png', is_private: false, is_redaction: true, url: '/api/links/attachments/1' },
])

function cover_document(cover: string) {
  return `---\ntitle: 测试\ncover: ${cover}\n---\n\n![正文插图](att://Vault.good/É.png)\n`
}

it.each(['![封面](ATT://portrait.PNG.good)', '![封面](att://vault.GOOD/E%CC%81.PNG)', 'Vault.good/É.png'])('flags a private attachment on the cover line: %s', (cover) => {
  const source = cover_document(cover)
  const doc = Text.of(source.split('\n'))
  const errors = build_diagnostics(source, doc, cover_config).filter(item => item.severity === 'error')
  expect(errors).toEqual([expect.objectContaining({ from: doc.line(3).from, to: doc.line(3).to, source: 'front-matter', message: private_cover_error_message })])
})

it.each(['![封面](att://Vault.good/Public.png)', '![封面](https://example.org/Portrait.png.good)'])('accepts public redactions and external images as covers: %s', (cover) => {
  const source = cover_document(cover)
  const doc = Text.of(source.split('\n'))
  expect(build_diagnostics(source, doc, cover_config).filter(item => item.severity === 'error')).toEqual([])
})

function html_diagnostics(body: string) {
  const source = `---\ntitle: 测试\ntime: 2026/1/1\n---\n${body}`
  const doc = Text.of(source.split('\n'))
  return build_diagnostics(source, doc, config).filter(item => item.source === 'html' || item.source === 'carousel')
}

it('accepts inline carousels and attributes, and checks their closing tags', () => {
  expect(html_diagnostics('前文 <carousel id="x" title="a > b">**正文**</carousel> 后文')).toEqual([])
  expect(html_diagnostics('前文 <carousel id="x">正文</div> 后文')).toEqual([
    expect.objectContaining({ source: 'html', severity: 'error', message: '闭合标签 </div> 与 <carousel> 不匹配，应为 </carousel>' }),
  ])
})

it('allows normal Markdown and nesting, and ignores fenced code examples', () => {
  const body = [
    '<carousel>',
    '普通 **文字** [链接][item] ![图][item]',
    '',
    '- 列表',
    '',
    '> 引用',
    '',
    '| A | B |',
    '| --- | --- |',
    '| a | b |',
    '',
    '<carousel>',
    '```md',
    '<carousel id="x">',
    '正文',
    '</carousel>',
    '```',
    '</carousel>',
    '</carousel>',
    '',
    '[item]: https://example.com',
  ].join('\n')
  expect(html_diagnostics(body)).toEqual([])
})
