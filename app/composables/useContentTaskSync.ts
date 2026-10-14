import type { ContentTaskState } from '@shared/types/content'
import { sync_resource } from '@shared/types/sync'
import { useContentTasksStore } from '~/stores/contentTasks'

/** Owns page subscriptions; the store owns task state and local transfer drivers. */
export async function useContentTaskSync(story_id: number) {
  const { content } = useApi()
  const store = useContentTasksStore(story_id)
  const resource = sync_resource('content_story_tasks', story_id)
  const unsubscribe = useDataSync().subscribe(resource, (event) => {
    if (event?.type === 'task_progress' && event.task_snapshot)
      store.apply_snapshot(event.task_snapshot)
  })
  onBeforeUnmount(unsubscribe)
  await useSyncedData<ContentTaskState[]>(resource, () => content.list_scope_tasks(story_id), {
    server: false,
    on_data: states => store.apply_list(states ?? []),
  })
}
