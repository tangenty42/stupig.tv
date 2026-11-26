import type { ContentAttachmentWorkspace } from '@shared/types/content'
import { sync_resource } from '@shared/types/sync'
import { error_message } from '~/utils/error'
import { read_content_resource } from '../resource'
import { accept_attachment_snapshot } from './model'

/** Server resources stay in Nuxt synced state; draft/runtime ownership stays separate. */
export function createAttachmentWorkspace(story_id: number) {
  const { content } = useApi()
  const { error: toast_error } = useMyToast()
  const state = useState<ContentAttachmentWorkspace | null>(`content_attachment_workspace:${story_id}`, () => null)
  const data = useSyncedState(computed<ContentAttachmentWorkspace | null>({
    get: () => state.value,
    set: (incoming) => {
      state.value = incoming ? accept_attachment_snapshot(state.value, incoming) : null
    },
  }))
  const loading = useState(`content_attachment_workspace_loading:${story_id}`, () => story_id > 0)
  const error = useState<string | null>(`content_attachment_workspace_error:${story_id}`, () => null)
  const failure_toast_shown = useState(`content_attachment_workspace_failure_toast:${story_id}`, () => false)
  const ready = story_id > 0
    ? useSyncedData(sync_resource('content_attachments', story_id), () => read_content_resource(() => content.get_attachment_workspace(story_id)), data, loading, {
        on_data: (value) => {
          error.value = value ? null : '附件列表不存在或已被删除'
          failure_toast_shown.value = false
        },
        on_error: (failure) => {
          error.value = error_message(failure) || '附件加载失败'
          if (! import.meta.server && ! failure_toast_shown.value) {
            failure_toast_shown.value = true
            toast_error(data.value === null ? '附件列表加载失败，请重试' : '附件列表更新失败')
          }
        },
      })
    : Promise.resolve(null)
  return {
    ready,
    data,
    loading,
    error,
    active: story_id > 0,
    async refresh() {
      failure_toast_shown.value = false
      await (await ready)?.refresh()
    },
    accept(incoming: ContentAttachmentWorkspace) {
      data.value = incoming
      error.value = null
      failure_toast_shown.value = false
    },
  }
}
