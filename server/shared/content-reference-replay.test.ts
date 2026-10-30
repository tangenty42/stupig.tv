import { describe, expect, it } from 'vitest'
import { replay_content_references } from './content-reference-replay'

const catalogs = {
  attachment_targets: [{ id: 1, name: 'C/a.png' }, { id: 2, name: 'B/b.png' }, { id: 3, name: 'C' }],
  title_targets: [{ id: 4, name: '新标题' }],
}

describe('reference journal replay', () => {
  it('rewrites persisted text identically without generating editor patches or diagnostics', () => {
    const text = '[x](att://a/file.txt#top) [s](content://Old)\n`[ignored](content://Old)`\n<good>unfinished'
    const namespace = { attachments: [{ revision: 1, changes: [{ node_id: 1, from: 'att://a', to: 'att://b', is_folder: true }] }],
      titles: [{ revision: 1, changes: [{ node_id: 2, from: 'content://Old', to: 'content://New' }] }], attachment_targets: [], title_targets: [] }
    const normal = replay_content_references(text, namespace)
    const persisted = replay_content_references(text, namespace, false)
    expect(persisted.markdown).toBe(normal.markdown)
    expect(normal.changes.length).toBeGreaterThan(0)
    expect(normal.diagnostics.length).toBeGreaterThan(0)
    expect(persisted.changes).toEqual([])
    expect(persisted.diagnostics).toEqual([])
  })
  it('matches normalized URIs while preserving parameters, fragments and unrelated destinations', () => {
    const markdown = '[](ATT://DOcs/E%CC%81.PNG?download=1#p2) [story](CONTENT://OLD?view=card#top) [](att://UNTOUCHED.PNG?x=2)'
    const result = replay_content_references(markdown, {
      attachments: [{ revision: 1, changes: [{ node_id: 1, from: 'att://Docs/É.png', to: 'att://Moved/Photo.PNG' }] }],
      titles: [{ revision: 2, changes: [{ node_id: 2, from: 'content://Old', to: 'content://NewTitle' }] }],
      attachment_targets: [{ id: 1, name: 'Moved/Photo.PNG' }, { id: 3, name: 'untouched.png' }], title_targets: [{ id: 2, name: 'NewTitle' }],
    })
    expect(result.markdown).toBe('[](att://Moved/Photo.PNG?download=1#p2) [story](content://NewTitle?view=card#top) [](att://UNTOUCHED.PNG?x=2)')
    expect(result.diagnostics).toEqual([])
  })

  it('keeps attachment and story identities separate and handles Unicode folder boundaries', () => {
    const result = replay_content_references('[](att://E%CC%81/Sub/A.png#page) [](att://Éx/a.png) [](content://É)', {
      attachments: [{ revision: 1, changes: [{ node_id: 1, from: 'att://é', to: 'att://Moved', is_folder: true }] }], titles: [],
      attachment_targets: [{ id: 1, name: 'Moved/Sub/A.png' }, { id: 2, name: 'Éx/a.png' }], title_targets: [{ id: 3, name: 'É' }],
    })
    expect(result.markdown).toBe('[](att://Moved/Sub/A.png#page) [](att://Éx/a.png) [](content://É)')
    expect(result.diagnostics).toEqual([])
  })

  it('follows the rename of a same-name attachment recreated after deletion', () => {
    const result = replay_content_references('[](att://old.png)', {
      attachment_targets: [{ id: 2, name: 'new.png' }], title_targets: [], titles: [],
      attachments: [
        { revision: 1, changes: [{ node_id: 1, from: 'att://old.png', to: null }] },
        { revision: 2, changes: [] },
        { revision: 3, changes: [{ node_id: 2, from: 'att://old.png', to: 'att://new.png' }] },
      ],
    })
    expect(result.markdown).toBe('[](att://new.png)')
    expect(result.diagnostics).toEqual([])
  })
  it('replays live definition destinations and silently resolves a same-name replacement', () => {
    const markdown = '[picture][p] [story][s]\r\n\r\n[p]: att://A/a.png "keep"\r\n[s]: content://Old\r\n[unused]: att://A/a.png'
    const result = replay_content_references(markdown, {
      attachment_targets: [{ id: 1, name: 'B/a.png' }], title_targets: [{ id: 2, name: 'New' }],
      attachments: [{ revision: 1, changes: [{ node_id: 1, from: 'att://A', to: 'att://B', is_folder: true }] }],
      titles: [{ revision: 1, changes: [{ node_id: 2, from: 'content://Old', to: 'content://New' }] }],
    })
    expect(result.markdown).toBe(markdown.replace('[p]: att://A/a.png', '[p]: att://B/a.png').replace('content://Old', 'content://New'))
    expect(result.diagnostics).toEqual([])
    expect(result.changes).toHaveLength(2)
    expect(result.changes.reduceRight((text, change) => text.slice(0, change.from) + change.insert + text.slice(change.to), markdown)).toBe(result.markdown)
    const deleted = replay_content_references('[f]\n\n[f]: att://old', {
      attachment_targets: [{ id: 99, name: 'old' }], title_targets: [], titles: [],
      attachments: [{ revision: 1, changes: [{ node_id: 1, from: 'att://old', to: null }] }],
    })
    expect(deleted.diagnostics).toEqual([])
  })
  it('replays simultaneous batches in order, including cover and folder cards, preserving unrelated text', () => {
    const markdown = '---\ntitle: 本文\ncover: att://A/a.png\n---\n[A/a.png](att://A/a.png) [](att://B/b.png) [](att://A/) [](content://旧标题)\n`[](att://A/a.png)`\n<div data-ref="att://A/a.png">正文</div>'
    const result = replay_content_references(markdown, {
      ... catalogs,
      attachments: [
        { revision: 1, changes: [{ node_id: 1, from: 'att://A', to: 'att://B', is_folder: true }, { node_id: 2, from: 'att://B', to: 'att://A', is_folder: true }] },
        { revision: 2, changes: [{ node_id: 1, from: 'att://B', to: 'att://C', is_folder: true }, { node_id: 2, from: 'att://A', to: 'att://B', is_folder: true }] },
      ],
      titles: [{ revision: 1, changes: [{ node_id: 4, from: 'content://旧标题', to: 'content://新标题' }] }],
    })
    expect(result.markdown).toContain('cover: att://C/a.png')
    expect(result.markdown).toContain('[C/a.png](att://C/a.png) [](att://B/b.png) [](att://C) [](content://新标题)')
    expect(result.markdown).toContain('`[](att://A/a.png)`')
    expect(result.markdown).toContain('<div data-ref="att://A/a.png">正文</div>')
    expect(result.diagnostics).toEqual([])
    expect(result.changes.reduceRight((text, change) => text.slice(0, change.from) + change.insert + text.slice(change.to), markdown)).toBe(result.markdown)
    // B/b.png returns to its original path, so only four ranges actually change.
    expect(result.changes).toHaveLength(4)
  })

  it('silently follows recreated attachment and story names', () => {
    const result = replay_content_references('[](att://old) [](content://旧标题)', {
      attachment_targets: [{ id: 77, name: 'new' }], title_targets: [{ id: 88, name: '旧标题' }],
      attachments: [
        { revision: 1, changes: [{ node_id: 1, from: 'att://old', to: null }] },
        { revision: 3, changes: [{ node_id: 77, from: 'att://old', to: 'att://new' }] },
      ],
      titles: [{ revision: 1, changes: [{ node_id: 4, from: 'content://旧标题', to: null }] }],
    })
    expect(result.markdown).toBe('[](att://new) [](content://旧标题)')
    expect(result.diagnostics).toEqual([])
  })

  it('follows a recreated story after it is renamed', () => {
    const result = replay_content_references('[](content://旧标题)', {
      attachment_targets: [], title_targets: [{ id: 2, name: '新标题' }], attachments: [],
      titles: [
        { revision: 1, changes: [{ node_id: 1, from: 'content://旧标题', to: null }] },
        { revision: 2, changes: [{ node_id: 2, from: 'content://旧标题', to: 'content://新标题' }] },
      ],
    })
    expect(result.markdown).toBe('[](content://新标题)')
    expect(result.diagnostics).toEqual([])
  })

  it('reports unresolved deletions as missing and matches title renames case insensitively', () => {
    const result = replay_content_references('[](att://gone) [](content://OLD)', {
      attachment_targets: [], title_targets: [{ id: 1, name: 'next' }],
      attachments: [{ revision: 1, changes: [{ node_id: 2, from: 'att://gone', to: null }] }],
      titles: [{ revision: 1, changes: [{ node_id: 1, from: 'content://old', to: 'content://next' }] }],
    })
    expect(result.markdown).toBe('[](att://gone) [](content://next)')
    expect(result.diagnostics).toMatchObject([{ target: 'gone', reason: 'missing' }])
  })
})
