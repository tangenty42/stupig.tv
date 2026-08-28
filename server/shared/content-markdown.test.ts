import type { ContentMarkdownConfig } from './content-markdown'
import { describe, expect, it } from 'vitest'
import {
  extract_attachment_names,
  extract_story_reference_titles,
  parse_story_markdown,
  rename_attachment_references,
  rename_story_references,
} from './content-markdown'

const config: ContentMarkdownConfig = {
  title_max_length: 120,
  label_max_bytes: 500,
  desc_max_bytes: 500,
  cover_max_bytes: 500,
  markdown_max_bytes: 100000,
  existing_titles: [
    { id: 1, title: '蠢猪，从何而来？' },
    { id: 3, title: '另一档案' },
  ],
}

function story_doc(body: string, title = '测试档案') {
  return `---\ntitle: ${title}\ntime: 2026/8/8\n---\n\n${body}`
}

describe('extract_attachment_names', () => {
  it('extracts link and image destinations', () => {
    expect(extract_attachment_names('[](a.zip) and ![](b.jpg)')).toEqual(['a.zip', 'b.jpg'])
  })

  it('catches both the nested link and the outer image destination', () => {
    // The regex this replaces consumed the nested link and orphaned the outer one.
    expect(extract_attachment_names('![关公面前耍大刀😇[](高二1班_蠢猪组.zip)](蠢猪组提交.jpg)').sort())
      .toEqual(['蠢猪组提交.jpg', '高二1班_蠢猪组.zip'].sort())
  })

  it('walks arbitrarily deep nesting inside labels', () => {
    expect(extract_attachment_names('![a [x [y](c.zip)](b.jpg)](a.png)').sort())
      .toEqual(['a.png', 'b.jpg', 'c.zip'].sort())
  })

  it('ignores story references, anchors, paths and external URLs', () => {
    expect(extract_attachment_names('[](@档案标题) [](#anchor) [](dir/a.jpg) [](https://example.com/x.jpg)')).toEqual([])
  })

  it('accepts angle destinations and title suffixes', () => {
    expect(extract_attachment_names('[](<a.jpg>) ![](b.jpg "标题")').sort()).toEqual(['a.jpg', 'b.jpg'].sort())
  })

  it('ignores link lookalikes inside inline code spans', () => {
    expect(extract_attachment_names('`[](a.jpg)` and `` `[](b.jpg)` ``')).toEqual([])
  })

  it('ignores link lookalikes inside fenced code blocks', () => {
    expect(extract_attachment_names('```md\n[](fenced.jpg)\n```\n\n[](real.jpg)')).toEqual(['real.jpg'])
  })

  it('ignores a `]` inside a code span within the label', () => {
    expect(extract_attachment_names('![a `]` b](x.jpg)')).toEqual(['x.jpg'])
  })

  it('ignores unterminated and unbalanced destinations', () => {
    expect(extract_attachment_names('[](a.jpg and [](b(c)')).toEqual([])
  })
})

describe('rename_attachment_references', () => {
  it('renames the destination and a default label, but keeps custom labels', () => {
    expect(rename_attachment_references('[a.jpg](a.jpg) [自定义](a.jpg)', 'a.jpg', 'b.jpg'))
      .toBe('[b.jpg](b.jpg) [自定义](b.jpg)')
  })

  it('renames a link nested inside an image label without breaking the outer image', () => {
    expect(rename_attachment_references('![关公面前耍大刀😇[](高二1班_蠢猪组.zip)](蠢猪组提交.jpg)', '高二1班_蠢猪组.zip', '新压缩包.zip'))
      .toBe('![关公面前耍大刀😇[](新压缩包.zip)](蠢猪组提交.jpg)')
  })

  it('renames the outer image destination without touching the nested link', () => {
    expect(rename_attachment_references('![关公面前耍大刀😇[](高二1班_蠢猪组.zip)](蠢猪组提交.jpg)', '蠢猪组提交.jpg', '新图.jpg'))
      .toBe('![关公面前耍大刀😇[](高二1班_蠢猪组.zip)](新图.jpg)')
  })

  it('preserves whitespace and title suffixes around the destination', () => {
    expect(rename_attachment_references('![](  a.jpg  "标题")', 'a.jpg', 'b.jpg'))
      .toBe('![](  b.jpg  "标题")')
  })

  it('leaves code spans and fenced blocks untouched', () => {
    expect(rename_attachment_references('`[](a.jpg)`\n\n```\n[](a.jpg)\n```\n\n[](a.jpg)', 'a.jpg', 'b.jpg'))
      .toBe('`[](a.jpg)`\n\n```\n[](a.jpg)\n```\n\n[](b.jpg)')
  })

  it('leaves unrelated links untouched', () => {
    expect(rename_attachment_references('[](other.jpg) [](@档案) text', 'a.jpg', 'b.jpg'))
      .toBe('[](other.jpg) [](@档案) text')
  })
})

describe('extract_story_reference_titles', () => {
  it('extracts link and image story references, deduplicated', () => {
    expect(extract_story_reference_titles('[](@蠢猪，从何而来？) ![图](@另一档案) [](@蠢猪，从何而来？)').sort())
      .toEqual(['另一档案', '蠢猪，从何而来？'].sort())
  })

  it('extracts references nested inside image labels', () => {
    expect(extract_story_reference_titles('![x[](@另一档案)](a.jpg)')).toEqual(['另一档案'])
  })

  it('ignores bare prose lookalikes and code spans', () => {
    expect(extract_story_reference_titles('正文 (@另一档案) 与 `[](@蠢猪，从何而来？)`')).toEqual([])
  })
})

describe('rename_story_references', () => {
  it('renames references and keeps labels and other text intact', () => {
    expect(rename_story_references('[](@旧标题) [文本](@旧标题) 正文 (@旧标题)', '旧标题', '新标题'))
      .toBe('[](@新标题) [文本](@新标题) 正文 (@旧标题)')
  })

  it('renames references nested inside image labels', () => {
    expect(rename_story_references('![x[](@旧标题)](a.jpg)', '旧标题', '新标题'))
      .toBe('![x[](@新标题)](a.jpg)')
  })
})

describe('parse_story_markdown at-story lint', () => {
  it('flags dead references with the body line number', () => {
    const { issues } = parse_story_markdown(story_doc('前言\n\n[](@不存在档案)'), config)
    expect(issues).toContainEqual({ line: 8, severity: 'error', source: 'at-story', message: '档案『不存在档案』不可引用' })
  })

  it('flags self references', () => {
    const { issues } = parse_story_markdown(story_doc('[](@测试档案)'), config)
    expect(issues).toContainEqual({ line: 6, severity: 'error', source: 'at-story', message: '不允许自我引用' })
  })

  it('accepts references to existing stories, including nested ones', () => {
    const { issues } = parse_story_markdown(story_doc('[](@蠢猪，从何而来？)\n![x[](@另一档案)](a.jpg)'), config)
    expect(issues.filter(issue => issue.source === 'at-story')).toEqual([])
  })

  it('ignores bare prose lookalikes and code spans', () => {
    const { issues } = parse_story_markdown(story_doc('正文 (@不存在档案) 与 `[](@也不存在)`'), config)
    expect(issues.filter(issue => issue.source === 'at-story')).toEqual([])
  })
})
