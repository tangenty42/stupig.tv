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
