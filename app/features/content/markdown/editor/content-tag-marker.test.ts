// @vitest-environment happy-dom
import { forceParsing } from '@codemirror/language'
import { EditorView } from '@codemirror/view'
import { expect, it } from 'vitest'
import { content_tag_marker_plugin } from './content-tag-marker'
import { editor_markdown_lang } from './language'
import { theme_extensions } from './themes'

function highlighted(view: EditorView, name: 'good' | 'carousel') {
  return Array.from(view.contentDOM.querySelectorAll(`.cm-content-tag-${name}`), tag => tag.textContent)
}

it('marks both ends of inline, standalone and nested custom tags', () => {
  const view = new EditorView({
    doc: '前文 <GOOD>机密</GOOD> <carousel title="A > B">轮播</carousel> 后文\n\n<carousel>\n<good>\n内容\n</good>\n</carousel>',
    extensions: [editor_markdown_lang, content_tag_marker_plugin, theme_extensions('dark')],
  })
  try {
    expect(forceParsing(view, view.state.doc.length, 1000)).toBe(true)
    expect(highlighted(view, 'good')).toEqual(['<GOOD>', '</GOOD>', '<good>', '</good>'])
    expect(highlighted(view, 'carousel')).toEqual(['<carousel title="A > B">', '</carousel>', '<carousel>', '</carousel>'])
  }
  finally {
    view.destroy()
  }
})

it('keeps literal tag examples and other HTML out of the custom highlighting', () => {
  const lines = [
    '---',
    'title: <good>标题</good>',
    '---',
    '',
    '`<good>代码</good>` \\<carousel>转义\\</carousel> <span title="<carousel>">HTML</span>',
    '',
    '```html',
    '<carousel>代码</carousel>',
    '```',
    '',
    '<!-- <good>注释</good> -->',
    '',
    '<pre><carousel>预格式化文字</carousel></pre>',
    '',
    '<good-example>其他标签</good-example>',
  ]
  const view = new EditorView({
    doc: lines.join('\n'),
    extensions: [editor_markdown_lang, content_tag_marker_plugin, theme_extensions('light')],
  })
  try {
    expect(forceParsing(view, view.state.doc.length, 1000)).toBe(true)
    expect(highlighted(view, 'good')).toEqual([])
    expect(highlighted(view, 'carousel')).toEqual([])
    view.dispatch({ changes: { from: view.state.doc.length, insert: '\n\n<carousel><good>新增</good></carousel>' } })
    expect(forceParsing(view, view.state.doc.length, 1000)).toBe(true)
    expect(highlighted(view, 'good')).toEqual(['<good>', '</good>'])
    expect(highlighted(view, 'carousel')).toEqual(['<carousel>', '</carousel>'])
  }
  finally {
    view.destroy()
  }
})
