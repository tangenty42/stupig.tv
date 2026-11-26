import type { ImageAttachment } from '@shared/content-markdown'
import type { AttachmentMarkdownItem, FolderMarkdownMode } from './drag'
import { content_selection_markdown } from './drag'

type AcceptMarkdown = (markdown: string, items: readonly string[]) => void

export function useAttachmentMarkdown(attachments: () => readonly ImageAttachment[], { notify_empty_folders = true } = {}) {
  const { info } = useMyToast()
  const request = shallowRef<{ selection: readonly AttachmentMarkdownItem[], accept: AcceptMarkdown } | null>(null)
  const markdown_pending = computed(() => request.value !== null)
  function finish(selection: readonly AttachmentMarkdownItem[], accept: AcceptMarkdown, mode: FolderMarkdownMode) {
    const { markdown, items, empty_folders } = content_selection_markdown(selection, attachments(), mode)
    if (notify_empty_folders && empty_folders.length) {
      const paths = empty_folders.slice(0, 3).join('、') + (empty_folders.length > 3 ? `等 ${empty_folders.length} 个文件夹` : '')
      info(`没有直属${mode === 'images' ? '图片' : '文件'}：${paths}`)
    }
    if (markdown)
      accept(markdown, items)
  }
  function request_markdown(selection: readonly AttachmentMarkdownItem[], accept: AcceptMarkdown) {
    if (selection.some(item => item.kind === 'folder'))
      request.value = { selection, accept }
    else
      finish(selection, accept, 'folder')
  }
  function cancel_markdown() {
    request.value = null
  }
  function confirm_markdown(mode: FolderMarkdownMode) {
    const current = request.value
    cancel_markdown()
    if (current)
      finish(current.selection, current.accept, mode)
  }
  return { markdown_pending, request_markdown, confirm_markdown, cancel_markdown }
}
