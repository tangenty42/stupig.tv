import { describe, expect, it } from 'vitest'
import { attachment_pick_from_file, picks_from_file_handles } from './picks'

describe('attachment_pick_from_file', () => {
  it('preserves independent declarations in a multi-file selection', async () => {
    const files = ['public.PNG', 'secret.PNG.good', 'second.GIF.GOOD'].map(name => new File(['bytes'], name))
    expect(files.map(attachment_pick_from_file).map(pick => [pick.file_name, pick.selection_root])).toEqual(files.map(file => [file.name, undefined]))
    const handles = files.map(file => ({ kind: 'file', name: file.name, getFile: async () => file }) as FileSystemFileHandle)
    const picks = await picks_from_file_handles(handles)
    expect(picks.map(pick => pick.file_name)).toEqual(files.map(file => file.name))
    expect(picks.map(pick => pick.handle)).toEqual(handles)
  })

  it('preserves private ancestors through recursive folder handles and webkit directory inputs', async () => {
    const file = (name: string) => ({ kind: 'file', name, getFile: async () => new File(['bytes'], name) })
    const directory = (name: string, children: unknown[]) => ({
      kind: 'directory',
      name,
      async* values() {
        yield* children
      },
    })
    const roots = [directory('photos.good', [file('a.PNG'), directory('sub', [file('b.GIF'), file('c.txt.good')])]),
      directory('public', [file('normal.txt'), directory('nested.good', [file('d.txt')])])]
    const expected = ['photos.good/a.PNG', 'photos.good/sub/b.GIF', 'photos.good/sub/c.txt.good', 'public/normal.txt', 'public/nested.good/d.txt']
    const picks = await picks_from_file_handles(roots as unknown as FileSystemHandle[])
    expect(picks.map(pick => pick.file_name).sort()).toEqual([... expected].sort())
    for (const pick of picks)
      expect(pick.selection_root).toBe(pick.file_name.split('/')[0])
    const input_picks = expected.map((path) => {
      const selected = new File(['bytes'], path.split('/').at(- 1)!)
      Object.defineProperty(selected, 'webkitRelativePath', { value: path })
      return attachment_pick_from_file(selected)
    })
    expect(input_picks.map(pick => [pick.file_name, pick.selection_root])).toEqual(expected.map(path => [path, path.split('/')[0]]))
  })

  // Raw names must reach the server intact so sanitize is an explicit resolve.
  it('preserves spaces and punctuation for server-side resolve', () => {
    const pick = attachment_pick_from_file(new File([new Uint8Array(1)], 'Thomas’ Calculus in SI Units, 14th Edition.pdf'))
    expect(pick.file_name).toBe('Thomas’ Calculus in SI Units, 14th Edition.pdf')
  })

  it('preserves the local extension case until resolve', () => {
    expect(attachment_pick_from_file(new File([new Uint8Array(1)], '照片 2026.PNG')).file_name).toBe('照片 2026.PNG')
  })
})
