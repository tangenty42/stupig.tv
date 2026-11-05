import type { ContentAttachmentWorkspace } from '@shared/types/content'
import { sync_resource } from '@shared/types/sync'
import { read_content_resource } from '../resource'
import { accept_attachment_snapshot } from './model'

/** Server resources stay in Nuxt synced state; draft/runtime ownership stays separate. */
export function createAttachmentWorkspace(story_id: number) {
  const { content } = useApi()
  const state = useState<ContentAttachmentWorkspace | null>(`content_attachment_workspace:${story_id}`, () => null)
  const data = useSyncedState(computed<ContentAttachmentWorkspace | null>({
    get: () => state.value,
    set: (incoming) => {
      state.value = incoming ? accept_attachment_snapshot(state.value, incoming) : null
    },
  }))
  const loading = useState(`content_attachment_workspace_loading:${story_id}`, () => false)
  const ready = story_id > 0
    ? useSyncedData(sync_resource('content_attachments', story_id), () => read_content_resource(() => content.get_attachment_workspace(story_id)), data, loading)
    : Promise.resolve()
  return {
    ready,
    data,
    loading,
    accept(incoming: ContentAttachmentWorkspace) {
      data.value = incoming
    },
  }
}
