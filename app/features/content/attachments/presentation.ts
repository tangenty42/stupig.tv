import type { ContentStoryAttachment } from '@shared/types/content'
import { attachment_path_is_private } from '@shared/content-markdown'
import { file_icon } from '~/features/content/attachments/rules'

export const unused_attachment_icon = 'lucide:link-2-off'
export const unused_attachment_class = 'ml-auto shrink-0 text-violet-600 dark:text-violet-400'
export const draft_unused_attachment_label = '当前草稿未引用'
export const published_unused_attachment_label = '未引用'
export const private_attachment_open_denied_message = '无权打开此机密附件！'

export interface ContentItemPresentation {
  icon: string
  tone: 'muted' | 'private' | 'redacted' | 'active' | 'error'
}

/** Shared by attachment rows and editor reference options; contains no actions. */
export function attachment_item_presentation(
  file: Pick<ContentStoryAttachment, 'file_name' | 'mime_type' | 'is_private' | 'is_redaction'>,
  upload_status?: string,
): ContentItemPresentation {
  // A stored file's flag is authoritative: a 删减版 stays public inside a private folder.
  const is_private = typeof file.is_private === 'boolean' ? file.is_private : attachment_path_is_private(file.file_name)
  const is_redaction = ! is_private && !! file.is_redaction
  return {
    icon: file_icon(file),
    tone: upload_status === 'error' ? 'error' : upload_status ? 'active' : is_private ? 'private' : is_redaction ? 'redacted' : 'muted',
  }
}

export function folder_item_presentation(expanded = false, error = false, is_private = false): ContentItemPresentation {
  return { icon: expanded ? 'lucide:chevron-down' : 'lucide:chevron-right', tone: error ? 'error' : is_private ? 'private' : 'muted' }
}
