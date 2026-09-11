import type { ContentStoryAttachment } from '@shared/types/content'

export type AttachmentUploadStatus = 'queued' | 'uploading' | 'paused' | 'completed' | 'error' | 'cancelled'

/** File view model for MyContentAttachmentCard: a stored attachment or a pending upload task. */
export type AttachmentFileCardData
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
    /** True when the source file (blob or handle) is available to resume. */
    can_resume: boolean
  }

/** Unified view model for MyContentAttachmentCard: a file row or a folder row. */
export type AttachmentCardData
  = | AttachmentFileCardData
    | {
      kind: 'folder'
      /** Full folder path (e.g. 'a/b'); the row carries it as data-folder. */
      path: string
      name: string
      collapsed: boolean
      /** Stored files anywhere under the folder (recursive). */
      count: number
      /** Drag-over highlight: this folder is the current drop target. */
      drop_target: boolean
      /** No-op or forbidden drop target (same-folder, self/descendant). */
      drop_disabled: boolean
      /** This folder is the target of the in-flight move batch. */
      moving: boolean
      /** Source/target/ancestor of the in-flight move batch: dimmed. */
      dimmed: boolean
      /** Any move batch is in flight: the row cannot be dragged. */
      batch_pending: boolean
    }

/** A file queued for upload from the editor, including its progress and abort control. */
export interface PendingAttachmentUpload {
  id: number
  uppy_id: string
  file: File | null
  /** FileSystemFileHandle for zero-copy resume; null when picked without one. */
  handle: FileSystemFileHandle | null
  /** Storage path under the story's attachment scope (`folder/name.png`). */
  file_name: string
  file_size: number
  mime_type: string | null
  progress: number
  /** Measured upload speed in bytes per second. */
  speed: number
  status: AttachmentUploadStatus
  message: string | null
  controller: AbortController | null
  insert_position: number | null
}

/** A file plus the path it should be stored under; folder uploads carry nested paths. */
export interface AttachmentUploadPick {
  file: File
  file_name: string
  /** FileSystemFileHandle from a picker/drop, for zero-copy resume after refresh. */
  handle?: FileSystemFileHandle | null
}

export function attachment_pick_from_file(file: File): AttachmentUploadPick {
  return { file, file_name: file.webkitRelativePath || file.name }
}

/** Recursively flatten File System Access handles (files or folders) into picks. */
async function collect_file_system_handle(handle: FileSystemHandle, parent: string, out: AttachmentUploadPick[]) {
  const path = parent ? `${parent}/${handle.name}` : handle.name
  if (handle.kind === 'file') {
    try {
      out.push({ file: await (handle as FileSystemFileHandle).getFile(), file_name: path, handle: handle as FileSystemFileHandle })
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
      out.push({ file: await file_system_entry_file(entry as FileSystemFileEntry), file_name: path })
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

export type AttachmentListItem = {
  key: string
  card: AttachmentFileCardData
} & (
  | { kind: 'stored', attachment: ContentStoryAttachment, move_source_file_name?: string }
  | { kind: 'upload', task: PendingAttachmentUpload }
)

/** Which corners of a selected row to round, so contiguous selections read as one block. */
export type MyContentAttachmentSelectionEdges = 'top' | 'bottom' | 'none' | 'both' | null

/** Interactive per-row state computed by the page and rendered by MyContentAttachmentCard. */
export interface MyContentAttachmentRowState {
  selected: boolean
  selection_edges: MyContentAttachmentSelectionEdges
  /** Stored files in the current selection, when this row is selected (drives the bulk-delete label). */
  selection_count: number
  delete_pending: boolean
  delete_disabled: boolean
  rename_disabled: boolean
  replace_disabled: boolean
  retry_disabled: boolean
  move_pending: boolean
  /**
   * A structure operation (move/rename/folder change) holds the scope's lock —
   * either this tab's own in-flight one or another client's. Drag and the
   * matching menu actions stay disabled so peers cannot collide into a 409.
   */
  structure_locked: boolean
}

/** A flat render row for MyContentAttachmentList: a folder row or a file row, fully described by the page. */
export interface MyContentAttachmentRow {
  /** Stable event identity (`folder:${path}` / `stored:${name}` / `upload:${id}`). */
  key: string
  depth: number
  /** Render data: the folder view model, or a stored/upload file card. */
  data: AttachmentCardData
  state: MyContentAttachmentRowState
  /** The page item for file rows (stored/upload); null for folder rows. */
  item: AttachmentListItem | null
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
 * Resolve a front matter `cover` link: bare file names are local attachments
 * whose object URL comes from the server payload (`cover_url`, root-relative);
 * anything else (external URL, `#` color) passes through unchanged.
 */
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
