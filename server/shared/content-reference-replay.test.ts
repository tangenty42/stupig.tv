import { describe, expect, it } from 'vitest'
import { replay_content_references } from './content-reference-replay'

const catalogs = {
  attachment_targets: [{ id: 1, name: 'C/a.png' }, { id: 2, name: 'B/b.png' }, { id: 3, name: 'C' }],
  title_targets: [{ id: 4, name: '新标题' }],
}

describe('reference journal replay', () => {
  it('replays live definition destinations with disjoint patches and detects replacement at the definition', () => {
    const markdown = '[picture][p] [story][s]\r\n\r\n[p]: att://A/a.png "keep"\r\n[s]: content://Old\r\n[unused]: att://A/a.png'
    const result = replay_content_references(markdown, {
      attachment_targets: [{ id: 1, name: 'B/a.png' }], title_targets: [{ id: 2, name: 'New' }],
      attachments: [{ revision: 1, changes: [{ node_id: 1, from: 'A', to: 'B', is_folder: true }] }],
      titles: [{ revision: 1, changes: [{ node_id: 2, from: 'Old', to: 'New' }] }],
    })
    expect(result.markdown).toBe(markdown.replace('[p]: att://A/a.png', '[p]: att://B/a.png').replace('content://Old', 'content://New'))
    expect(result.diagnostics).toEqual([])
    expect(result.changes).toHaveLength(2)
    expect(result.changes.reduceRight((text, change) => text.slice(0, change.from) + change.insert + text.slice(change.to), markdown)).toBe(result.markdown)
    const deleted = replay_content_references('[f]\n\n[f]: att://old', {
      attachment_targets: [{ id: 99, name: 'old' }], title_targets: [], titles: [],
      attachments: [{ revision: 1, changes: [{ node_id: 1, from: 'old', to: null }] }],
    })
    expect(deleted.diagnostics).toEqual([{ kind: 'attachment', target: 'old', from: 10, to: 19, line: 3, reason: 'replaced' }])
  })
  it('replays simultaneous batches in order, including cover and folder cards, preserving unrelated text', () => {
    const markdown = '---\ntitle: 本文\ncover: att://A/a.png\n---\n[A/a.png](att://A/a.png) [](att://B/b.png) [](att://A/) [](content://旧标题)\n`[](att://A/a.png)`\n<div data-ref="att://A/a.png">正文</div>'
    const result = replay_content_references(markdown, {
      ... catalogs,
      attachments: [
        { revision: 1, changes: [{ node_id: 1, from: 'A', to: 'B', is_folder: true }, { node_id: 2, from: 'B', to: 'A', is_folder: true }] },
        { revision: 2, changes: [{ node_id: 1, from: 'B', to: 'C', is_folder: true }, { node_id: 2, from: 'A', to: 'B', is_folder: true }] },
      ],
      titles: [{ revision: 1, changes: [{ node_id: 4, from: '旧标题', to: '新标题' }] }],
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

  it('detects a deleted target recreated under the same name, and stops following its new owner', () => {
    const result = replay_content_references('[](att://old) [](content://旧标题)', {
      attachment_targets: [{ id: 99, name: 'old' }], title_targets: [{ id: 88, name: '旧标题' }],
      attachments: [
        { revision: 1, changes: [{ node_id: 1, from: 'old', to: null }] },
        { revision: 3, changes: [{ node_id: 77, from: 'old', to: 'new' }] },
      ],
      titles: [{ revision: 1, changes: [{ node_id: 4, from: '旧标题', to: null }] }],
    })
    expect(result.markdown).toBe('[](att://old) [](content://旧标题)')
    expect(result.diagnostics).toEqual([
      { kind: 'attachment', target: 'old', from: 3, to: 12, line: 1, reason: 'replaced' },
      { kind: 'story', target: '旧标题', from: 17, to: 30, line: 1, reason: 'replaced' },
    ])
  })

  it('reports unresolved deletions as missing and matches title renames case insensitively', () => {
    const result = replay_content_references('[](att://gone) [](content://OLD)', {
      attachment_targets: [], title_targets: [{ id: 1, name: 'next' }],
      attachments: [{ revision: 1, changes: [{ node_id: 2, from: 'gone', to: null }] }],
      titles: [{ revision: 1, changes: [{ node_id: 1, from: 'old', to: 'next' }] }],
    })
    expect(result.markdown).toBe('[](att://gone) [](content://next)')
    expect(result.diagnostics).toMatchObject([{ target: 'gone', reason: 'missing' }])
  })
})
