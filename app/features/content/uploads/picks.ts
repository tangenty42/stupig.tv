/** A file plus the path it should be stored under; folder uploads carry nested paths. */
export interface AttachmentUploadPick {
  file: File
  file_name: string
  selection_root?: string
  /** A dropped file can carry a handle for zero-copy resume after refresh. */
  handle?: FileSystemFileHandle | null
}

export const unreadable_upload_file_message = '无法读取原文件，请检查文件和读取权限，重新选择后继续'

/** Multipart readers can relay the browser's exception name on an ordinary Error. */
export function upload_file_read_error(error: unknown) {
  if (error instanceof Error && ['NotAllowedError', 'NotReadableError', 'NotFoundError', 'SecurityError', 'AbortError'].includes(error.name))
    return Object.assign(new Error(unreadable_upload_file_message), { code: 'UPLOAD_FILE_UNREADABLE' })
  return null
}

export function attachment_pick_from_file(file: File): AttachmentUploadPick {
  return { file, file_name: file.webkitRelativePath || file.name, ... (file.webkitRelativePath ? { selection_root: file.webkitRelativePath.split('/')[0]! } : {}) }
}

/** Recursively flatten File System Access handles (files or folders) into picks. */
async function collect_file_system_handle(handle: FileSystemHandle, parent: string, out: AttachmentUploadPick[]) {
  const path = parent ? `${parent}/${handle.name}` : handle.name
  try {
    if (handle.kind === 'file') {
      out.push({ file: await (handle as FileSystemFileHandle).getFile(), file_name: path, handle: handle as FileSystemFileHandle, ... (parent ? { selection_root: path.split('/')[0]! } : {}) })
      return
    }
    for await (const child of (handle as FileSystemDirectoryHandle).values())
      await collect_file_system_handle(child, path, out)
  }
  catch {
    // One unavailable entry must not discard the other files in a drop.
  }
}

export async function picks_from_file_handles(handles: FileSystemHandle[]): Promise<AttachmentUploadPick[]> {
  const picks: AttachmentUploadPick[] = []
  await Promise.all(handles.map(handle => collect_file_system_handle(handle, '', picks)))
  return picks
}
