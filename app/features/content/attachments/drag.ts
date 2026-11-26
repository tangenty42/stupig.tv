import type { ImageAttachment } from '@shared/content-markdown'
import type { ContentStoryAttachment } from '@shared/types/content'
import { attachment_folder_of, attachment_markdown_path, compare_attachment_names } from '@shared/content-markdown'
import { content_name_key } from '@shared/content-reference'

export const content_attachment_drag_type = 'application/x-stupig-content-attachment'
export const content_folder_drag_type = 'application/x-stupig-content-folder'

export interface ContentFolderDragData {
  folder: string
  file_names?: string[]
}

export type ContentAttachmentDragData = Pick<ContentStoryAttachment, 'file_name' | 'is_image' | 'url'> & {
  /** All file names being dragged when a multi-selection is dragged; absent for single drags. */
  file_names?: string[]
}

/** Every file name carried by a drag payload (the selection for multi-drags, else the single file). */
export function content_attachment_drag_file_names(data: ContentAttachmentDragData) {
  return data.file_names?.length ? data.file_names : [data.file_name]
}

export function content_attachment_markdown(attachment: ImageAttachment) {
  // Label-off: the preview renders the file name itself (card / caption-off).
  return `${attachment.is_image ? '!' : ''}[](${attachment_markdown_path(attachment.file_name)})`
}

/**
 * Markdown shorthand for a folder: the same un-prefixed link form a non-image
 * file uses, which the preview renders as a folder card. Used by both the
 * copy action and the editor drop, so the two cannot drift apart.
 */
export function content_folder_markdown(folder: string) {
  return content_attachment_markdown({ file_name: folder, is_image: false })
}

export type AttachmentMarkdownItem = { path: string } & ({ kind: 'folder' } | { kind: 'file', is_image: boolean })
export type FolderMarkdownMode = 'folder' | 'files' | 'images'

export function content_attachment_markdown_group(items: readonly string[]) {
  const markdown = items.join('\n')
  if (items.length < 2)
    return markdown
  const body = markdown.split('\n').map(line => `  ${line}`).join('\n')
  return `<carousel>\n${body}\n</carousel>`
}

export function resolve_markdown_selection(paths: readonly string[], attachments: readonly ImageAttachment[], folders: readonly string[], origin?: AttachmentMarkdownItem) {
  const items = new Map<string, AttachmentMarkdownItem>()
  if (origin)
    items.set(content_name_key(origin.path), origin)
  for (const path of folders)
    items.set(content_name_key(path), { path, kind: 'folder' })
  for (const file of attachments)
    items.set(content_name_key(file.file_name), { path: file.file_name, kind: 'file', is_image: file.is_image })
  return paths.flatMap(path => items.get(content_name_key(path)) ?? [])
}

export function content_selection_markdown(selection: readonly AttachmentMarkdownItem[], attachments: readonly ImageAttachment[], mode: FolderMarkdownMode) {
  const children = new Map<string, ImageAttachment[]>()
  if (mode !== 'folder') {
    const folder_keys = new Set(selection.filter(item => item.kind === 'folder').map(item => content_name_key(item.path)))
    for (const file of attachments) {
      const parent = attachment_folder_of(file.file_name)
      if (! parent || (mode === 'images' && ! file.is_image))
        continue
      const key = content_name_key(parent)
      if (! folder_keys.has(key))
        continue
      const siblings = children.get(key) ?? []
      siblings.push(file)
      children.set(key, siblings)
    }
  }
  const lines: string[] = []
  const seen = new Set<string>()
  const empty_folders: string[] = []
  const append = (path: string, markdown: string) => {
    const key = content_name_key(path)
    if (! seen.has(key)) {
      seen.add(key)
      lines.push(markdown)
    }
  }
  for (const item of selection) {
    if (item.kind === 'file') {
      append(item.path, content_attachment_markdown({ file_name: item.path, is_image: item.is_image }))
    }
    else if (mode === 'folder') {
      append(item.path, content_folder_markdown(item.path))
    }
    else {
      const files = children.get(content_name_key(item.path))
      if (! files?.length) {
        empty_folders.push(item.path)
        continue
      }
      files.sort((a, b) => compare_attachment_names(a.file_name, b.file_name))
      for (const file of files)
        append(file.file_name, content_attachment_markdown(file))
    }
  }
  return { markdown: content_attachment_markdown_group(lines), items: lines, empty_folders }
}
