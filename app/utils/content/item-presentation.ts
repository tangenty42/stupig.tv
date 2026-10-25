import type { ContentStoryAttachment } from '@shared/types/content'
import { attachment_path_is_private } from '@shared/content-markdown'
import { file_icon } from './attachment'

export interface ContentItemPresentation {
  icon: string
  tone: 'muted' | 'private' | 'redacted' | 'active' | 'error'
}

/** Shared by attachment rows and editor reference options; contains no actions. */
export function attachment_item_presentation(
  file: Pick<ContentStoryAttachment, 'file_name' | 'mime_type' | 'is_private' | 'has_redacted'>,
  upload_status?: string,
): ContentItemPresentation {
  const is_private = file.is_private || attachment_path_is_private(file.file_name)
  return {
    icon: is_private ? 'lucide:lock' : file_icon(file),
    tone: upload_status === 'error' ? 'error' : upload_status ? 'active' : is_private ? file.has_redacted ? 'redacted' : 'private' : 'muted',
  }
}

export function folder_item_presentation(expanded = false, error = false, is_private = false): ContentItemPresentation {
  return { icon: expanded ? 'lucide:chevron-down' : 'lucide:chevron-right', tone: error ? 'error' : is_private ? 'private' : 'muted' }
}
