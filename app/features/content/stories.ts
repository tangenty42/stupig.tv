import type { ContentStoryBody, ContentStorySummary } from '@shared/types/content'
import { sync_resource } from '@shared/types/sync'
import { read_content_resource } from './resource'

/** Shared published-story query used by list, reader and editor pages. */
export function useContentStories() {
  const { content } = useApi()
  const stories = useSyncedState<ContentStorySummary[] | null>('content_stories', () => null)
  const loading = useState('content_stories_loading', () => false)
  const ready = useSyncedData(
    sync_resource('content_stories', 'all'),
    () => content.list_stories(),
    stories,
    loading,
  )

  return { stories, loading, ready }
}

/** One story body with the same shared absence, refresh and hydration semantics. */
export function useContentStory(story_key: Readonly<Ref<string | number>>) {
  const { content } = useApi()
  const scope = String(story_key.value)
  const story = useSyncedState<ContentStoryBody | null>(`content_story_view_${scope}`, () => null)
  const loading = useState(`content_story_view_loading_${scope}`, () => false)
  const story_id = computed(() => Number(story_key.value))
  const ready = useSyncedData(
    computed(() => Number.isInteger(story_id.value) && story_id.value > 0 ? sync_resource('content_story', story_id.value) : null),
    () => read_content_resource(() => content.get_story_body(story_id.value)),
    story,
    loading,
  )

  return { story, loading, ready }
}
