<template>
  <div class="pb-12 pt-8">
    <template v-if="story">
      <MyContentStoryHeader back :editable="is_admin" :title="story.title" :labels="story.labels" :desc="story.desc" :cover="story.cover" :cover-label="story.cover_label" :cover-version="cover_version" :date="format_event_range(story.event_precision, story.event_dates)" :story-id="story.id" />

      <MyDivider class="mt-12">
        正文
      </MyDivider>

      <MyHeightSection tag="section" class="section-card-collapse mt-6">
        <MyContentMarkdownPreview :markdown="story.markdown" :story-id="story.id" :attachments="story.attachments" :stories="stories ?? []" />
      </MyHeightSection>

      <MyDivider class="mt-12">
        事件日历
      </MyDivider>

      <MyHeightSection tag="section" class="section-card-collapse mt-6">
        <MyContentStoryCalendar
          :stories="stories ?? []"
          :highlight_id="story.id"
          :initial_month="story.event_dates[0]?.slice(0, 7) ?? null"
        />
      </MyHeightSection>
    </template>

    <div v-else class="section-card-collapse py-12 text-center text-slate-500 dark:text-slate-400">
      档案不存在或已被删除
    </div>
  </div>
</template>

<script setup lang="ts">
import type { ContentStoryDetail, ContentStorySummary } from '@shared/types/content'
import { sync_resource } from '@shared/types/sync'
import { story_front_cover_url } from '~/utils/content/attachment'
import { format_event_range } from '~/utils/content/event'

const route = useRoute()
const { content } = useApi()
const { user } = useAuth()

const story_id = computed(() => Number(route.params.id))
const is_admin = computed(() => Boolean(user.value?.is_admin))

const story = useState<ContentStoryDetail | null>(`content_story_view_${String(route.params.id)}`, () => null)
const loading = useState(`content_story_view_loading_${String(route.params.id)}`, () => false)

useHead({
  title: computed(() => story.value ? `蠢猪档案 - ${story.value.title}` : undefined),
})

await useSyncedData<ContentStoryDetail>(
  computed(() => {
    const id = story_id.value
    return Number.isInteger(id) && id > 0 ? sync_resource('content_story', id) : null
  }),
  async () => {
    const current = story.value
    if (! current) {
      return content.get_story(story_id.value)
    }
    return await content.get_story(story_id.value, current.updated_at) ?? current
  },
  story,
  loading,
)

const stories = useState<ContentStorySummary[] | null>('content_stories', () => null)
const stories_loading = useState('content_stories_loading', () => false)

await useSyncedData<ContentStorySummary[]>(
  computed(() => sync_resource('content_stories', 'all')),
  () => content.list_stories(),
  stories,
  stories_loading,
)

const cover_version = computed(() => {
  const cover = story.value?.cover
  return cover && ! cover.includes('/') && ! cover.startsWith('#') && ! /^[a-z][\w+.-]*:/i.test(cover)
    ? (story.value?.attachments.find(item => item.file_name === cover)?.version ?? null)
    : null
})

// Seo getters are evaluated during head rendering (no Nuxt instance), so the
// composable is captured here and passed in rather than called inside the util.
const static_url = useStaticUrl()
const og_image = computed(() => {
  const current = story.value
  if (! current?.cover || current.cover.startsWith('#')) {
    return undefined
  }
  return story_front_cover_url(static_url, current.cover, current.id, cover_version.value)
})

useSeoMeta({
  description: computed(() => story.value?.desc ?? undefined),
  ogTitle: computed(() => story.value ? `蠢猪档案 - ${story.value.title}` : undefined),
  ogDescription: computed(() => story.value?.desc ?? undefined),
  ogType: 'article',
  ogImage: og_image,
  articlePublishedTime: computed(() => story.value?.created_at),
  articleModifiedTime: computed(() => story.value?.updated_at),
})
</script>
