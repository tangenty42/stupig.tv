import type { AttachmentUploadPick } from '~/features/content/uploads/picks'
import { attachment_pick_from_file, picks_from_file_handles } from '~/features/content/uploads/picks'

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
