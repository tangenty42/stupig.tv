import type { ContentStoryAttachment } from '@shared/types/content'
import { is_encrypted_attachment } from '@shared/content-markdown'

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
    const { image: _image, encryption_key: _key, ... public_fields } = attachment
    return { ... public_fields, url: null, is_redacted_view: Boolean(attachment.redacted_url && attachment.redacted_image) }
  })
}

export function attachment_display_url(static_url: (path: string) => string, attachment: Pick<ContentStoryAttachment, 'url' | 'is_private'>) {
  return attachment.url ? attachment.is_private ? attachment.url : static_url(attachment.url) : ''
}

/** Match the rendered URL: DOM .href expands relative attachment routes to absolute URLs. */
export function attachment_for_link<T>(attachments: ReadonlyMap<string, T>, link: Pick<HTMLAnchorElement, 'getAttribute'>) {
  return attachments.get(link.getAttribute('href') ?? '')
}

/** A redacted presentation belongs to this row; other attachments are independent. */
export function redacted_version_of(attachments: ContentStoryAttachment[], file_name: string) {
  const source = attachments.find(item => item.file_name === file_name)
  if (source?.redacted_url && source.redacted_image)
    return { ... source, url: source.redacted_url, image: source.redacted_image, is_private: false }
  return null
}

export type AttachmentUploadStatus = 'queued' | 'uploading' | 'paused' | 'completed' | 'error' | 'cancelled'

/** A file plus the path it should be stored under; folder uploads carry nested paths. */
export interface AttachmentUploadPick {
  file: File
  file_name: string
  selection_root?: string
  /** FileSystemFileHandle from a picker/drop, for zero-copy resume after refresh. */
  handle?: FileSystemFileHandle | null
}

export function attachment_pick_from_file(file: File): AttachmentUploadPick {
  return { file, file_name: file.webkitRelativePath || file.name, ... (file.webkitRelativePath ? { selection_root: file.webkitRelativePath.split('/')[0]! } : {}) }
}

/** Recursively flatten File System Access handles (files or folders) into picks. */
async function collect_file_system_handle(handle: FileSystemHandle, parent: string, out: AttachmentUploadPick[]) {
  const path = parent ? `${parent}/${handle.name}` : handle.name
  if (handle.kind === 'file') {
    try {
      out.push({ file: await (handle as FileSystemFileHandle).getFile(), file_name: path, handle: handle as FileSystemFileHandle, ... (parent ? { selection_root: path.split('/')[0]! } : {}) })
    }
    catch {
      // Skip unreadable files rather than failing the whole drop.
    }
    return
  }
  try {
    for await (const child of (handle as FileSystemDirectoryHandle).values())
      await collect_file_system_handle(child, path, out)
  }
  catch {
    // Skip unreadable directories rather than failing the whole drop.
  }
}

/** Flatten File System Access handles (files or folders) into upload picks. */
export async function picks_from_file_handles(handles: FileSystemHandle[]): Promise<AttachmentUploadPick[]> {
  const picks: AttachmentUploadPick[] = []
  await Promise.all(handles.map(handle => collect_file_system_handle(handle, '', picks)))
  return picks
}

function file_system_entry_file(entry: FileSystemFileEntry) {
  return new Promise<File>((resolve, reject) => entry.file(resolve, reject))
}

function read_directory_batch(reader: FileSystemDirectoryReader) {
  return new Promise<FileSystemEntry[]>((resolve, reject) => {
    reader.readEntries(entries => resolve(entries), error => reject(error))
  })
}

async function collect_file_system_entry(entry: FileSystemEntry, parent: string, out: AttachmentUploadPick[]) {
  const path = parent ? `${parent}/${entry.name}` : entry.name
  if (entry.isFile) {
    try {
      out.push({ file: await file_system_entry_file(entry as FileSystemFileEntry), file_name: path, ... (parent ? { selection_root: path.split('/')[0]! } : {}) })
    }
    catch {
      // Skip unreadable files rather than failing the whole drop.
    }
    return
  }
  if (entry.isDirectory) {
    try {
      const reader = (entry as FileSystemDirectoryEntry).createReader()
      let batch: FileSystemEntry[]
      do {
        batch = await read_directory_batch(reader)
        for (const child of batch)
          await collect_file_system_entry(child, path, out)
      } while (batch.length)
    }
    catch {
      // Skip unreadable directories rather than failing the whole drop.
    }
  }
}

/**
 * Flatten a drop into upload picks, preserving folder structure. Prefers the
 * File System Access handles (Chromium) so picks carry a resumable handle;
 * falls back to the entry API (Safari) and then the flat file list.
 */
export async function attachment_picks_from_data_transfer(data_transfer: DataTransfer | null): Promise<AttachmentUploadPick[]> {
  if (! data_transfer)
    return []

  if (typeof DataTransferItem.prototype.getAsFileSystemHandle === 'function') {
    const handles: FileSystemHandle[] = []
    for (const item of [... data_transfer.items]) {
      try {
        const handle = await item.getAsFileSystemHandle?.()
        if (handle)
          handles.push(handle)
      }
      catch {
        // Internal drags have no handle; fall through to the entry API below.
      }
    }
    if (handles.length) {
      const picks = await picks_from_file_handles(handles)
      if (picks.length)
        return picks
    }
  }

  const entries: FileSystemEntry[] = []
  for (let index = 0; index < data_transfer.items.length; index ++) {
    const entry = data_transfer.items[index]?.webkitGetAsEntry?.()
    if (entry)
      entries.push(entry)
  }
  if (! entries.length)
    return [... data_transfer.files].map(attachment_pick_from_file)

  const picks: AttachmentUploadPick[] = []
  await Promise.all(entries.map(entry => collect_file_system_entry(entry, '', picks)))
  return picks
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
// (this list, menus, completions) mark encrypted attachments with the plain
// lock; the keyhole variants belong to rendered content (see link-cards).
export function file_icon(attachment: Pick<ContentStoryAttachment, 'file_name' | 'mime_type'> & { encryption_key?: string }) {
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
 * Triggers a browser save of `url`. For an http(s) URL the save name comes from
 * the response's Content-Disposition (see the signed download URL); `name` only
 * names blob: URLs, where no headers exist.
 */
export function save_url_as(url: string, name?: string) {
  const anchor = document.createElement('a')
  anchor.href = url
  if (name)
    anchor.download = name
  anchor.click()
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

export function story_front_cover_url(static_url: (path: string) => string, cover: string, cover_url?: string | null) {
  const segments = cover.split('/')
  // Bare names and folder paths point at the story's attachments.
  if (! cover.startsWith('#') && ! /^[a-z][\w+.-]*:/i.test(cover) && segments.every(Boolean))
    return cover_url ? static_url(cover_url) : undefined
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
