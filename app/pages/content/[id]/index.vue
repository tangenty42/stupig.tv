<template>
  <div class="pb-12 pt-8">
    <template v-if="story">
      <div class="flex items-start gap-3">
        <Button class="aspect-square" outlined aria-label="返回" @click="router.back()">
          <template #icon>
            <MyIcon name="lucide:arrow-left" />
          </template>
        </Button>
        <Button
          v-if="is_admin"
          class="ml-auto"
          size="small"
          severity="secondary"
          text
          label="编辑"
          @click="navigateTo(`/content/${story.id}/edit`)"
        >
          <template #icon>
            <MyIcon name="lucide:pencil" />
          </template>
        </Button>
      </div>

      <MyContentStoryHeader class="mt-4" :title="story.title" :labels="story.labels" :desc="story.desc" :cover="story.cover" :cover-label="story.cover_label" :date="format_event_range(story.event_precision, story.event_dates)" :story-id="story.id" />

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
import { format_event_range } from '~/utils/content/event'

const route = useRoute()
const router = useRouter()
const { content } = useApi()
const { user } = useAuth()

const story_id = computed(() => Number(route.params.id))
const is_admin = computed(() => Boolean(user.value?.is_admin))

const story = useState<ContentStoryDetail | null>(`content_story_view_${String(route.params.id)}`, () => null)
const loading = useState(`content_story_view_loading_${String(route.params.id)}`, () => false)

await useSyncedData<ContentStoryDetail>(
  computed(() => {
    const id = story_id.value
    return Number.isInteger(id) && id > 0 ? sync_resource('content_story', id) : null
  }),
  () => content.get_story(story_id.value),
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
</script>
