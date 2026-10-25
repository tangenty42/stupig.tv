import type { ContentStoryAttachment } from '@shared/types/content'
import { describe, expect, it } from 'vitest'
import { attachment_can_read, attachment_display_url, attachment_for_link, attachment_is_media, attachment_leading_action, attachment_pick_from_file, picks_from_file_handles, redacted_version_of } from './attachment'

function attachment(mime_type: string | null) {
  return { mime_type } as Pick<ContentStoryAttachment, 'mime_type'>
}

it('only reads redacted fields from the owner row and ignores legacy sibling names and metadata', () => {
  const owner = { file_name: '8888.jpg.good', id: 1, is_private: true } as ContentStoryAttachment
  const sibling = { ... owner, file_name: '8888.jpg', redaction_source_id: 1, url: '/ordinary', is_private: false }
  expect(redacted_version_of([owner, sibling], owner.file_name)).toBeNull()
  const redacted_image = { revision: 1, width: 2, height: 2, has_original: false, lqip: null }
  expect(redacted_version_of([{ ... owner, redacted_url: '/same-row-redacted', redacted_image }, sibling], owner.file_name))
    .toMatchObject({ id: 1, url: '/same-row-redacted', image: redacted_image, is_private: false })
})

it.each(['/api/content/attachments/11?version=v1', 'https://static.test/objects/file.txt'])('matches a card to its attachment using the rendered href: %s', (url) => {
  const file = { file_name: 'file.txt' }
  // Native anchors expose an absolute .href even when the renderer supplied
  // a relative route. No DOM is needed to reproduce those two representations.
  const link = { href: new URL(url, 'https://site.test').href, getAttribute: (name: string) => name === 'href' ? url : null }
  expect(attachment_for_link(new Map([[url, file]]), link)).toBe(file)
  expect(attachment_for_link(new Map(), link)).toBeUndefined()
})

it('resolves private addresses without a public static prefix and treats a missing projection as denied', () => {
  const source = { url: '/api/content/private-attachments/11', is_private: true, is_encrypted: false }
  const static_url = (path: string) => `https://static.test${path}`
  expect(attachment_display_url(static_url, source)).toBe(source.url)
  expect(attachment_can_read(source)).toBe(true)
  expect(attachment_display_url(static_url, { ... source, url: null })).toBe('')
  expect(attachment_can_read({ ... source, url: null })).toBe(false)
})

describe('attachment_is_media', () => {
  // The exemption is what keeps a video/audio row opening inline instead of
  // being forced into a download, so the prefix list has to cover all three
  // media families rather than images alone.
  it('treats image, video and audio as viewable media', () => {
    expect(attachment_is_media(attachment('image/png'))).toBe(true)
    expect(attachment_is_media(attachment('image/svg+xml'))).toBe(true)
    expect(attachment_is_media(attachment('video/mp4'))).toBe(true)
    expect(attachment_is_media(attachment('audio/mpeg'))).toBe(true)
  })

  it('leaves documents and unknown types as downloads', () => {
    expect(attachment_is_media(attachment('application/pdf'))).toBe(false)
    expect(attachment_is_media(attachment('text/markdown'))).toBe(false)
    expect(attachment_is_media(attachment('application/octet-stream'))).toBe(false)
    expect(attachment_is_media(attachment(null))).toBe(false)
  })

  // A mime type with no subtype separator must not read as media; matching is
  // anchored so `imagex/foo` cannot slip through.
  it('anchors the type prefix', () => {
    expect(attachment_is_media(attachment('imagex/png'))).toBe(false)
    expect(attachment_is_media(attachment('notimage/png'))).toBe(false)
  })
})

describe('attachment_leading_action', () => {
  const row = (mime_type: string | null, is_image: boolean) => ({ mime_type, is_image })

  it('previews images, opens other media, downloads the rest', () => {
    expect(attachment_leading_action(row('image/png', true))).toBe('preview')
    expect(attachment_leading_action(row('video/mp4', false))).toBe('open')
    expect(attachment_leading_action(row('audio/mpeg', false))).toBe('open')
    expect(attachment_leading_action(row('application/pdf', false))).toBe('download')
    expect(attachment_leading_action(row('text/markdown', false))).toBe('download')
  })

  // Encryption is deliberately not an input: the row's action depends on its
  // type alone, so a private video cannot collapse to "download" the way a
  // short-circuit on the encrypted flag made it.
  it('has no encrypted input that could override the type', () => {
    const media = { mime_type: 'video/mp4', is_image: false, is_encrypted: true, encryption_key: 'k' }
    expect(attachment_leading_action(media)).toBe('open')
  })
})

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
