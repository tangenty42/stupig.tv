import type { ContentStoryAttachment } from '@shared/types/content'
import { attachment_markdown_path } from '@shared/content-markdown'

export const content_attachment_drag_type = 'application/x-stupig-content-attachment'

export type ContentAttachmentDragData = Pick<ContentStoryAttachment, 'file_name' | 'is_image' | 'url'>

export function set_content_attachment_drag_data(event: DragEvent, attachment: ContentAttachmentDragData) {
  if (! event.dataTransfer)
    return

  event.dataTransfer.effectAllowed = 'copy'
  event.dataTransfer.setData(content_attachment_drag_type, JSON.stringify(attachment))
}

export function get_content_attachment_drag_data(data_transfer: DataTransfer | null) {
  const raw = data_transfer?.getData(content_attachment_drag_type)
  if (! raw)
    return null

  try {
    const data = JSON.parse(raw) as Partial<ContentAttachmentDragData>
    if (typeof data.file_name !== 'string' || typeof data.url !== 'string' || typeof data.is_image !== 'boolean')
      return null
    return {
      file_name: data.file_name,
      is_image: data.is_image,
      url: data.url,
    }
  }
  catch {
    return null
  }
}

export function content_attachment_markdown(attachment: ContentAttachmentDragData) {
  return `${attachment.is_image ? '!' : ''}[${attachment.file_name}](${attachment_markdown_path(attachment.file_name)})`
}
