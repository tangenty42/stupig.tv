import type { ContentAttachmentDragData, ContentFolderDragData } from '~/features/content/attachments/drag'
import { content_attachment_drag_type, content_folder_drag_type } from '~/features/content/attachments/drag'

export { content_attachment_drag_type, content_folder_drag_type } from '~/features/content/attachments/drag'

export function set_content_attachment_drag_data(event: DragEvent, attachment: ContentAttachmentDragData) {
  if (! event.dataTransfer)
    return

  // 'copyMove': the markdown editor copies the reference while folder rows move the
  // file. A plain 'copy' forbids the 'move' dropEffect those rows set, so the browser
  // would cancel the drop entirely (dragend without drop).
  event.dataTransfer.effectAllowed = 'copyMove'
  event.dataTransfer.setData(content_attachment_drag_type, JSON.stringify(attachment))
}

export function get_content_attachment_drag_data(data_transfer: DataTransfer | null) {
  const raw = data_transfer?.getData(content_attachment_drag_type)
  if (! raw)
    return null

  try {
    const data = JSON.parse(raw) as Partial<ContentAttachmentDragData>
    if (typeof data.file_name !== 'string' || (data.url !== null && typeof data.url !== 'string') || typeof data.is_image !== 'boolean')
      return null
    const file_names = Array.isArray(data.file_names) && data.file_names.every(name => typeof name === 'string')
      ? data.file_names
      : undefined
    return {
      file_name: data.file_name,
      is_image: data.is_image,
      url: data.url,
      file_names,
    }
  }
  catch {
    return null
  }
}

export function set_content_folder_drag_data(event: DragEvent, folder: string, file_names?: string[]) {
  if (! event.dataTransfer)
    return
  // 'copyMove', for the same reason the attachment payload uses it: a folder is
  // dragged both onto folder rows (move) and into the markdown editor, which
  // asks for 'copy' because it inserts a reference rather than relocating
  // anything. 'move' alone makes the browser reject that drop with a
  // "not-allowed" cursor before the drop handler ever runs.
  event.dataTransfer.effectAllowed = 'copyMove'
  event.dataTransfer.setData(content_folder_drag_type, JSON.stringify({
    folder,
    file_names: file_names?.length ? file_names : undefined,
  } satisfies ContentFolderDragData))
}

export function get_content_folder_drag_data(data_transfer: DataTransfer | null): ContentFolderDragData | null {
  const raw = data_transfer?.getData(content_folder_drag_type)
  if (! raw)
    return null
  try {
    const data = JSON.parse(raw) as Partial<ContentFolderDragData>
    if (typeof data.folder !== 'string')
      return null
    const file_names = Array.isArray(data.file_names) && data.file_names.every(name => typeof name === 'string')
      ? data.file_names
      : undefined
    return { folder: data.folder, file_names }
  }
  catch {
    // Older drags used the folder path directly as the payload.
    return { folder: raw }
  }
}
