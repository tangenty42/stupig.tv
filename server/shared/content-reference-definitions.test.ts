import type { ContentMarkdownConfig } from './content-markdown'
import { describe, expect, it } from 'vitest'
import { content_ref_changes, extract_attachment_names, extract_story_reference_titles, lint_content_refs, map_content_refs, rename_attachment_references, rename_story_references } from './content-markdown'

const config: ContentMarkdownConfig = { title_max_length: 120, label_max_bytes: 500, desc_max_bytes: 500, cover_max_bytes: 500, markdown_max_bytes: 100000, attachment_paths: ['a.txt'], existing_titles: [{ id: 2, title: 'Old' }] }
describe('reference definitions through render, dependency, lint and rewrite entry points', () => {
  it.each(['[label][f]', '[f][]', '[f]', '![label][f]', '![f][]', '![f]'])('tracks %s and edits only the shared destination', (usage) => {
    const source = `${usage}\n\n[f]: <att://a.txt> 'kept title'`
    expect(extract_attachment_names(source)).toEqual(['a.txt'])
    const next = rename_attachment_references(source, 'a.txt', 'b.txt')
    expect(next).toBe(source.replace('att://a.txt', 'att://b.txt'))
    const from = source.indexOf('att://')
    expect(content_ref_changes(source, next)).toEqual([{ from, to: from + 'att://a.txt'.length, insert: 'att://b.txt' }])
  })

  it('uses normalized labels and the first definition, ignoring unused and shadowed targets', () => {
    const source = '[label][ A  B ]\n\n[a b]: att://a.txt\n[A B]: att://shadow.txt\n[unused]: att://unused.txt'
    expect(extract_attachment_names(source)).toEqual(['a.txt'])
    expect(lint_content_refs(source, config)).toEqual([])
    expect(rename_attachment_references(source, 'shadow.txt', 'changed.txt')).toBe(source)
  })

  it.each([
    '[label][f]\n\n[f]:\n  <att://a.txt>\n  "multiline title"',
    '> [label][f]\n>\n> [f]: att://a.txt',
    '- [label][f]\n\n  [f]: att://a.txt',
    '[label][f\\!x]\n\n[f\\!x]: att://a.txt',
    '<div>\n    [f]: att://a.txt\n    [label][f]\n</div>',
    '- <div>\n\t[f]: att://a.txt\n\t[label][f]\n\t</div>',
    '> <div>\n> [f]: att://a.txt\n> [label][f]\n> </div>',
    '😀 [label][f]\r\n\r\n[f]: <att://a.txt> "title"\r\n',
  ])('preserves destination offsets in containers, escaped labels and CRLF: %s', (source) => {
    expect(extract_attachment_names(source)).toEqual(['a.txt'])
    const next = rename_attachment_references(source, 'a.txt', 'b.txt')
    expect(next).toBe(source.replace('att://a.txt', 'att://b.txt'))
    const changes = content_ref_changes(source, next)
    expect(changes).toHaveLength(1)
    expect(source.slice(changes[0]!.from, changes[0]!.to)).toBe('att://a.txt')
  })

  it('collects a shared target once and updates only default labels while keeping definition IDs', () => {
    const source = '[a.txt][f] [f][] [f]\n\n[f]: att://a.txt'
    expect(extract_attachment_names(source)).toEqual(['a.txt'])
    expect(rename_attachment_references(source, 'a.txt', 'b.txt')).toBe('[b.txt][f] [f][] [f]\n\n[f]: att://b.txt')
    const locations: string[] = []
    map_content_refs(source, (destination, from, to) => {
      locations.push(source.slice(from, to))
      return destination
    })
    expect(locations).toEqual(['att://a.txt'])
  })

  it('applies story rename and self-reference validation only to explicit business definitions', () => {
    const source = '[label][s]\n\n[s]: content://Old'
    expect(extract_story_reference_titles(source)).toEqual(['Old'])
    expect(rename_story_references(source, 'old', 'New')).toBe(source.replace('content://Old', 'content://New'))
    expect(lint_content_refs(source, config, 'Old')).toEqual([expect.objectContaining({ severity: 'warning', source: 'at-story' })])
    const legacy = '[label][f]\n\n[f]: a.txt'
    expect(lint_content_refs(legacy, config)).toEqual([])
    expect(extract_attachment_names(legacy)).toEqual([])
  })

  it.each([
    '`[f]`\n\n[f]: att://a.txt',
    '```md\n[f]\n```\n\n[f]: att://a.txt',
    '    [f]\n\n[f]: att://a.txt',
    '[f]\n\n```md\n[f]: att://a.txt\n```',
    '[f]\n\n    [f]: att://a.txt',
    '<pre>[f]</pre>\n\n[f]: att://a.txt',
    '<table><tr><td>[f] [](att://a.txt)</td></tr></table>\n\n[f]: att://a.txt',
    '<table><tr><td><table><tr><td>nested</td></tr></table>[](att://a.txt)</td></tr></table>',
    '<table>\n```\ncode\n```\n[](att://a.txt)\n</table>',
    '<!-- [f] -->\n\n[f]: att://a.txt',
    // A blank line splits this HTML block; the four-space definition is code,
    // not a definition rendered by the complete-wrapper plugin.
    '<div>\n    [label][f]\n\n    [f]: att://a.txt\n</div>',
    '\\[f]\n\n[f]: att://a.txt',
  ])('does not create dependencies from code, HTML tables, comments or escaped uses: %s', (source) => {
    expect(extract_attachment_names(source)).toEqual([])
    expect(rename_attachment_references(source, 'a.txt', 'b.txt')).toBe(source)
  })

  it('keeps definitions with invalid trailing text unresolved', () => {
    const source = '[f]\n\n[f]: att://a.txt garbage'
    expect(extract_attachment_names(source)).toEqual([])
  })

  it('does not let duplicate definitions inside raw HTML override a real definition', () => {
    const source = '<table><tr><td>\n[f]: att://hidden.txt\n</td></tr></table>\n\n[f]\n\n[f]: att://a.txt'
    expect(extract_attachment_names(source)).toEqual(['a.txt'])
  })

  it('retains links that Markdown actually parses next to inline HTML table tags', () => {
    const source = 'prefix <table><tr><td>[](att://a.txt)</td></tr></table>'
    expect(extract_attachment_names(source)).toEqual(['a.txt'])
    expect(rename_attachment_references(source, 'a.txt', 'b.txt')).toBe(source.replace('att://a.txt', 'att://b.txt'))
  })

  it('keeps unrelated metadata intact and maps a multiline definition in a quote', () => {
    const source = '---\ntitle: [f]: att://metadata.txt\ntime: 2026/10/22\n---\n> [label][f]\n>\n> [f]:\n>   <att://a.txt>\n>   "title"'
    expect(extract_attachment_names(source)).toEqual(['a.txt'])
    const next = rename_attachment_references(source, 'a.txt', 'b.txt')
    expect(next).toBe(source.replace('att://a.txt', 'att://b.txt'))
  })

  it.each([
    ['att://&#97;.txt', 'a.txt'],
    ['att://a\\-b.txt', 'a-b.txt'],
    ['att://%E5%9B%BE.txt', '图.txt'],
  ])('resolves %s semantically without normalizing unrelated source', (destination, name) => {
    const source = `[f]\n\n[f]: <${destination}> 'keep'`
    expect(extract_attachment_names(source)).toEqual([name])
    expect(map_content_refs(source, value => value)).toBe(source)
    expect(rename_attachment_references(source, 'unrelated', 'next.txt')).toBe(source)
    expect(rename_attachment_references(source, name, 'next.txt')).toBe(source.replace(destination, 'att://next.txt'))
  })
})
