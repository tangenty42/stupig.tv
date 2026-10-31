import { EditorState } from '@codemirror/state'
import { extract_attachment_names, rename_attachment_references } from '@shared/content-markdown'
import { replay_content_references } from '@shared/content-reference-replay'
import { describe, expect, it } from 'vitest'
import { create_story_markdown } from './index'

// Keep the browser renderer integration in the app project. Shared/server
// suites must not pull DOM-dependent renderer modules into their type graph.
function render(source: string, name = 'a.txt') {
  const md = create_story_markdown({ story_id: () => 1, attachments: () => [{ file_name: name, mime_type: 'text/plain', is_image: false, file_size: 1, version: 'v1', url: `/objects/${name}` }], stories: () => [], static_url: path => path, folder_card_openable: () => false })
  return md.render(source, { images: [] })
}

describe('rendered references and business dependencies agree', () => {
  it.each([
    ['[![photo.png.good](att://docs/photo.png.good)][o]', '[![photo.png](att://docs/photo.png)][o]', false],
    ['![custom ![photo.png.good](att://docs/photo.png.good)][o]', '![custom ![photo.png](att://docs/photo.png)][o]', false],
    ['[![photo.png.good][p]][o]', '[![photo.png][p]][o]', true],
    ['![custom [photo.png.good][p]][o]', '![custom [photo.png][p]][o]', true],
  ] as const)('applies nested reference edits through real CodeMirror without overlapping changes: %s', (usage, rewritten, uses_p) => {
    const source = `${usage}\n\n[o]: att://outer.png\n[p]: att://docs/photo.png.good`
    const result = replay_content_references(source, {
      attachments: [{ revision: 1, changes: [{ node_id: 1, from: 'att://docs/photo.png.good', to: 'att://docs/photo.png' }] }],
      titles: [], attachment_targets: [], title_targets: [],
    })
    const expected_definition = uses_p ? '[p]: att://docs/photo.png' : '[p]: att://docs/photo.png.good'
    const expected = `${rewritten}\n\n[o]: att://outer.png\n${expected_definition}`
    expect(result.markdown).toBe(expected)
    // Inline targets do not activate an unrelated definition of the same URL.
    if (! uses_p)
      expect(result.markdown.split('\n').at(- 1)).toBe('[p]: att://docs/photo.png.good')
    for (let index = 1; index < result.changes.length; index ++)
      expect(result.changes[index - 1]!.to).toBeLessThanOrEqual(result.changes[index]!.from)
    const updated = EditorState.create({ doc: source }).update({ changes: result.changes }).state
    expect(updated.doc.toString()).toBe(expected)
  })
  it('renders the new default filename after declassification and keeps a custom caption', () => {
    const source = '[photo.png.good](att://docs/photo.png.good) ![photo.png.good][p] ![我写的说明][p]\n\n[p]: att://docs/photo.png.good'
    const next = replay_content_references(source, {
      attachments: [{ revision: 1, changes: [{ node_id: 1, from: 'att://docs/photo.png.good', to: 'att://docs/photo.png' }] }],
      titles: [], attachment_targets: [{ id: 1, name: 'docs/photo.png' }], title_targets: [],
    }).markdown
    const md = create_story_markdown({ story_id: () => 1, attachments: () => [{ file_name: 'docs/photo.png', mime_type: 'image/png', is_image: true, file_size: 1, version: 'v1', url: '/objects/photo' }],
      stories: () => [], static_url: path => path, folder_card_openable: () => false })
    const html = md.render(next, { images: [] })
    expect(html).toContain('alt="photo.png"')
    expect(html).toContain('aria-label="预览：photo.png"')
    expect(html).toContain('我写的说明')
    expect(html).not.toContain('photo.png.good')
  })
  it('resolves entity-escaped targets identically in rendering and reference checks', () => {
    const source = '[f]\n\n[f]: att://&#97;.txt'
    expect(render(source, 'a.txt')).toContain('/objects/a.txt')
    expect(extract_attachment_names(source)).toEqual(['a.txt'])
  })
  it.each([
    '[label][f]\n\n[f]: att://a.txt',
    '[f][] [f] ![f]\n\n[f]: att://a.txt',
    '[label][ A  B ]\n\n[a b]: att://a.txt\n[A B]: att://shadow.txt',
    '> [label][f]\n>\n> [f]:\n>   <att://a.txt>\n>   "title"',
    '- <div>\n\t[f]: att://a.txt\n\t[label][f]\n\t</div>',
    '<div>\n    [f]: att://a.txt\n    [label][f]\n</div>',
    '😀 [label][f]\r\n\r\n[f]: att://a.txt\r\n',
    'prefix <table><tr><td>[](att://a.txt)</td></tr></table>',
  ])('renders the same attachment that deletion protects and rename follows: %s', (source) => {
    expect(render(source)).toContain('/objects/a.txt')
    expect(extract_attachment_names(source)).toEqual(['a.txt'])
    const next = rename_attachment_references(source, 'a.txt', 'b.txt')
    expect(render(next, 'b.txt')).toContain('/objects/b.txt')
    expect(extract_attachment_names(next)).toEqual(['b.txt'])
  })

  it.each([
    '<table><tr><td>[f] [](att://a.txt)</td></tr></table>\n\n[f]: att://a.txt',
    '```md\n[f]\n```\n\n[f]: att://a.txt',
    '<div>\n    [label][f]\n\n    [f]: att://a.txt\n</div>',
    '[f]\n\n[f]: att://a.txt garbage',
  ])('neither renders nor protects an inactive target: %s', (source) => {
    expect(render(source)).not.toContain('/objects/a.txt')
    expect(extract_attachment_names(source)).toEqual([])
    expect(rename_attachment_references(source, 'a.txt', 'b.txt')).toBe(source)
  })
})
