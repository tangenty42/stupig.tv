import { describe, expect, it } from 'vitest'
import { find_delete_references } from './content-delete-impact'

describe('delete impact uses the live reference grammar', () => {
  it('finds covers, definitions and directory content changes with normalized identities', () => {
    const source = '---\ncover: ATT://DOCS/E%CC%81.PNG?x=1\n---\n[dir](att://docs)\n[ref][file]\n\n[file]: att://docs/é.png#top\n`[](att://docs/é.png)`'
    expect(find_delete_references(source, [{ path: 'docs/É.png', kind: 'file' }])).toEqual([
      { target: 'DOCS/E\u0301.PNG', line: 2, effect: 'missing' },
      { target: 'docs', line: 4, effect: 'contents' },
      { target: 'docs/é.png', line: 7, effect: 'missing' },
    ])
  })

  it('distinguishes a deleted directory from its parent and ignores unrelated story names', () => {
    const source = '[](att://a) [](att://a/b) [](att://a/b/c) [](att://a/bc) [](content://a)'
    const hits = find_delete_references(source, [{ path: 'A/B', kind: 'folder' }])
    expect(hits).toEqual([
      { target: 'a', line: 1, effect: 'contents' },
      { target: 'a/b', line: 1, effect: 'missing' },
      { target: 'a/b/c', line: 1, effect: 'missing' },
    ])
    expect(find_delete_references(source, [{ path: 'A', kind: 'story' }])).toEqual([{ target: 'a', line: 1, effect: 'missing' }])
  })
})
