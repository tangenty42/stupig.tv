import type { ContentStoryAttachment } from '@shared/types/content'
import type { WorkspaceListRow } from './workspace-model'
import { attachment_markdown_path } from '@shared/content-markdown'

export const content_attachment_drag_type = 'application/x-stupig-content-attachment'
export const content_folder_drag_type = 'application/x-stupig-content-folder'

export interface ContentFolderDragData {
  folder: string
  file_names?: string[]
  markdown?: string
}

export type ContentAttachmentDragData = Pick<ContentStoryAttachment, 'file_name' | 'is_image' | 'url'> & {
  /** All file names being dragged when a multi-selection is dragged; absent for single drags. */
  file_names?: string[]
  markdown?: string
}

/** Every file name carried by a drag payload (the selection for multi-drags, else the single file). */
export function content_attachment_drag_file_names(data: ContentAttachmentDragData) {
  return data.file_names?.length ? data.file_names : [data.file_name]
}

export function content_attachment_markdown(attachment: ContentAttachmentDragData) {
  // Label-off: the preview renders the file name itself (card / caption-off).
  return `${attachment.is_image ? '!' : ''}[](${attachment_markdown_path(attachment.file_name)})`
}

/**
 * Markdown shorthand for a folder: the same un-prefixed link form a non-image
 * file uses, which the preview renders as a folder card. Used by both the
 * copy action and the editor drop, so the two cannot drift apart.
 */
export function content_folder_markdown(folder: string) {
  return content_attachment_markdown({ file_name: folder, is_image: false, url: '' })
}

/** Clipboard and editor drags share the exact same ordered references. */
export function content_selection_markdown(rows: readonly WorkspaceListRow[]) {
  return rows.filter(row => row.node).map(row => row.node!.kind === 'folder' ? content_folder_markdown(row.path) : content_attachment_markdown(row.node!.attachment!)).join('\n')
}
