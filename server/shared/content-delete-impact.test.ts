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

  it('ignores folder images but reports live images and folder cards inside a carousel', () => {
    const source = [
      '![](att://Album)', '![旧写法][sub]', '',
      '<carousel>', '  ![](att://album/sub/photo.png)', '  [](att://album/other)', '</carousel>', '',
      '[sub]: att://album/sub/',
    ].join('\n')
    expect(find_delete_references(source, [{ path: 'album', kind: 'folder' }], ['album/sub', 'album/other'])).toEqual([
      { target: 'album/sub/photo.png', line: 5, effect: 'missing' },
      { target: 'album/other', line: 6, effect: 'missing' },
    ])
    expect(find_delete_references(source, [{ path: 'album/sub/photo.png', kind: 'file' }])).toEqual([
      { target: 'album/sub/photo.png', line: 5, effect: 'missing' },
    ])
  })

  it('counts a URL definition shared by an image and an ordinary folder link', () => {
    const source = '![旧写法][folder]\n[][folder]\n\n[folder]: att://Album/'
    expect(find_delete_references(source, [{ path: 'album/item.txt', kind: 'file' }], ['album'])).toEqual([
      { target: 'Album', line: 4, effect: 'contents' },
    ])
  })

  it('finds both direct and paired references to a public redaction without matching the reverse', () => {
    const source = '![完整](att://Docs/Photo.PNG.GOOD)\n\n![公开](att://docs/photo.png)\n\n`![](att://docs/photo.png.good)`'
    expect(find_delete_references(source, [{ path: 'docs/photo.png', kind: 'file', redaction_of: 'docs/photo.png.good' }])).toEqual([
      { target: 'Docs/Photo.PNG.GOOD', line: 1, effect: 'missing' },
      { target: 'docs/photo.png', line: 3, effect: 'missing' },
    ])
    expect(find_delete_references(source, [{ path: 'docs/photo.png.good', kind: 'file' }])).toEqual([
      { target: 'Docs/Photo.PNG.GOOD', line: 1, effect: 'missing' },
    ])
  })
})
