import type { ContentStoryAttachment } from '@shared/types/content'

export type AttachmentUploadStatus = 'queued' | 'uploading' | 'completed' | 'error' | 'cancelled'

/** Unified view model for MyContentAttachmentCard: a stored attachment or a pending upload task. */
export type AttachmentCardData
  = | (ContentStoryAttachment & {
    kind: 'stored'
    /** Unreferenced stored attachments are deleted when the story is saved. */
    referenced: boolean
    /** Live progress while this stored file is being replaced by a new upload. */
    replacing?: { progress: number, speed: number }
  })
  | {
    kind: 'upload'
    file_name: string
    mime_type: string | null
    file_size: number
    status: AttachmentUploadStatus
    progress: number
    /** Live upload speed in bytes per second. */
    speed: number
    message: string | null
  }

export const file_icon_names = [
  'file',
  'file-archive',
  'file-audio',
  'file-code-2',
  'file-image',
  'file-text',
  'file-video',
  'sheet',
] as const

export function file_icon(attachment: Pick<ContentStoryAttachment, 'file_name' | 'mime_type'>) {
  const mime_type = attachment.mime_type ?? ''
  const extension = attachment.file_name.split('.').pop()?.toLowerCase() ?? ''
  if (mime_type.startsWith('image/'))
    return 'file-image'
  if (mime_type.startsWith('video/'))
    return 'file-video'
  if (mime_type.startsWith('audio/'))
    return 'file-audio'
  if (mime_type.startsWith('text/') || mime_type === 'application/pdf')
    return 'file-text'
  if (['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz'].includes(extension))
    return 'file-archive'
  if (['js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'vue', 'html', 'css', 'json', 'xml', 'yaml', 'yml'].includes(extension))
    return 'file-code-2'
  if (['csv', 'xls', 'xlsx', 'ods'].includes(extension))
    return 'sheet'
  return 'file'
}

/**
 * Resolve a front matter `cover` link the same way the markdown preview resolves
 * attachment URLs: bare file names point at the story's attachment directory
 * (story_id null means the new-story editor, whose orphan uploads live under content/0/).
 * A `version` is appended as `?version=` to cache-bust replaced files.
 */
export function story_front_cover_url(static_url: (path: string) => string, cover: string, story_id: number | null, version?: string | null) {
  if (! cover.includes('/') && ! cover.startsWith('#') && ! /^[a-z][\w+.-]*:/i.test(cover)) {
    const path = `/content/${story_id ?? 0}/${cover}`
    return static_url(version ? `${path}?version=${version}` : path)
  }
  return cover
}

/**
 * Alt text for a cover image: the markdown label (`![label](file.jpg)`) when
 * present, otherwise the cover's file name.
 */
export function cover_alt(cover: string | null | undefined, cover_label: string | null | undefined, fallback: string) {
  const label = cover_label?.trim()
  if (label) {
    return label
  }
  return cover?.split('/').pop() || fallback
}
