import { extract_attachment_names, rename_attachment_references } from '@shared/content-markdown'
import { describe, expect, it } from 'vitest'
import { create_story_markdown } from './index'

// Keep the browser renderer integration in the app project. Shared/server
// suites must not pull DOM-dependent renderer modules into their type graph.
function render(source: string, name = 'a.txt') {
  const md = create_story_markdown({ story_id: () => 1, attachments: () => [{ file_name: name, mime_type: 'text/plain', is_image: false, file_size: 1, version: 'v1', url: `/objects/${name}`, is_encrypted: false }], stories: () => [], static_url: path => path, video_card: () => null, folder_card_openable: () => false })
  return md.render(source, { images: [], bilibili_hrefs: [] })
}

describe('rendered references and business dependencies agree', () => {
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
