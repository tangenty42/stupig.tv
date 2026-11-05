import type { ContentStoryAttachment } from '@shared/types/content'
import { is_encrypted_attachment } from '@shared/content-markdown'
import { content_name_key } from '@shared/content-reference'

export function attachment_is_restricted(attachment: Pick<ContentStoryAttachment, 'is_private'>) {
  return !! attachment.is_private
}

export function attachment_can_read(attachment: Pick<ContentStoryAttachment, 'url'>) {
  return !! attachment.url
}

/** Preview the same representation an unprivileged reader receives without mutating the editing catalog. */
export function public_preview_attachments(attachments: ContentStoryAttachment[]) {
  return attachments.map((attachment) => {
    if (! attachment_is_restricted(attachment))
      return attachment
    const { image: _image, ... public_fields } = attachment
    return { ... public_fields, url: null, is_redacted_view: Boolean(attachment.redacted_url && attachment.redacted_image) }
  })
}

export function attachment_display_url(static_url: (path: string) => string, attachment: Pick<ContentStoryAttachment, 'url' | 'is_private'>) {
  return attachment.url ? attachment.is_private ? attachment.url : static_url(attachment.url) : ''
}

/** A redacted presentation belongs to this row; other attachments are independent. */
export function redacted_version_of(attachments: ContentStoryAttachment[], file_name: string) {
  const source = attachments.find(item => content_name_key(item.file_name) === content_name_key(file_name))
  if (source?.redacted_url && source.redacted_image)
    return { ... source, url: source.redacted_url, image: source.redacted_image, is_private: false }
  return null
}

export const file_icon_names = [
  'lucide:file',
  'lucide:file-archive',
  'lucide:file-audio',
  'lucide:file-code-2',
  'lucide:file-image',
  'lucide:file-text',
  'lucide:file-video',
  'lucide:lock',
  'lucide:sheet',
] as const

// The names carry the collection prefix so Nuxt Icon's client-bundle scan
// (which matches literal `lucide:*` strings) picks them up. Admin surfaces
// (this list, menus, completions) mark confidential attachments with the plain
// lock; the keyhole variants belong to rendered content (see link-cards).
export function file_icon(attachment: Pick<ContentStoryAttachment, 'file_name' | 'mime_type'>) {
  if (is_encrypted_attachment(attachment.file_name))
    return 'lucide:lock'
  const mime_type = attachment.mime_type ?? ''
  const extension = attachment.file_name.split('.').pop()?.toLowerCase() ?? ''
  if (mime_type.startsWith('image/'))
    return 'lucide:file-image'
  if (mime_type.startsWith('video/'))
    return 'lucide:file-video'
  if (mime_type.startsWith('audio/'))
    return 'lucide:file-audio'
  if (mime_type.startsWith('text/') || mime_type === 'application/pdf')
    return 'lucide:file-text'
  if (['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz'].includes(extension))
    return 'lucide:file-archive'
  if (['js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'vue', 'html', 'css', 'json', 'xml', 'yaml', 'yml'].includes(extension))
    return 'lucide:file-code-2'
  if (['csv', 'xls', 'xlsx', 'ods'].includes(extension))
    return 'lucide:sheet'
  return 'lucide:file'
}

/**
 * Whether the row is viewable in a browser tab (image, video, audio): it opens
 * inline by default and is exempt from the forced download; a download stays
 * available as its own action.
 */
export function attachment_is_media(attachment: Pick<ContentStoryAttachment, 'mime_type'>) {
  return /^(?:image|video|audio)\//.test(attachment.mime_type ?? '')
}

/** The viewer an attachment's leading action opens it in. */
export type AttachmentLeadingAction = 'preview' | 'open' | 'download'

/**
 * The leading action for an attachment: images preview in the lightbox, other
 * media opens in a tab, everything else downloads.
 *
 * Encrypted rows are not distinguished here — they reach the same action through
 * the decrypt path instead of the object URL, which is what keeps a private
 * video as openable as a public one.
 */
export function attachment_leading_action(attachment: Pick<ContentStoryAttachment, 'is_image' | 'mime_type'>): AttachmentLeadingAction {
  if (attachment.is_image)
    return 'preview'
  return attachment_is_media(attachment) ? 'open' : 'download'
}
