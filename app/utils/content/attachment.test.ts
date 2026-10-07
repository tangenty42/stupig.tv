import type { ContentStoryAttachment } from '@shared/types/content'
import { describe, expect, it } from 'vitest'
import { attachment_is_media, attachment_leading_action } from './attachment'

function attachment(mime_type: string | null) {
  return { mime_type } as Pick<ContentStoryAttachment, 'mime_type'>
}

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
