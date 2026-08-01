<template>
  <div class="space-y-6 pb-12 pt-8">
    <div v-if="loading && ! story" class="space-y-4">
      <Skeleton height="2rem" width="50%" />
      <Skeleton height="16rem" />
    </div>

    <template v-else-if="story">
      <MyHeightSection tag="section" class="section-card-collapse">
        <div class="flex flex-wrap items-start justify-between gap-4">
          <div class="flex items-center gap-3">
            <Button text rounded aria-label="返回" @click="navigateTo('/content')">
              <template #icon>
                <MyIcon name="lucide:arrow-left" />
              </template>
            </Button>
            <h1>{{ story.title }}</h1>
          </div>
          <Button
            v-if="is_admin"
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

        <div class="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2 pl-12 text-sm text-slate-500 dark:text-slate-400">
          <span class="flex items-center text-amber-400" :title="`评分 ${story.rating}`">
            <MyIcon
              v-for="star in story.rating"
              :key="star"
              name="lucide:star"
              class="fill-amber-400"
            />
          </span>
          <span class="flex flex-wrap gap-1">
            <span
              v-for="entry in event_entries"
              :key="entry"
              class="rounded-full bg-slate-100 px-2 py-0.5 text-xs dark:bg-slate-800"
            >
              {{ entry }}
            </span>
          </span>
          <span class="text-xs"><ClientOnly>更新于 {{ datetime_format(story.updated_at) }}</ClientOnly></span>
        </div>
      </MyHeightSection>

      <MyHeightSection tag="section" class="section-card">
        <MyContentMarkdownPreview :markdown="story.markdown" :story-id="story.id" :attachments="story.attachments" />
      </MyHeightSection>
    </template>

    <div v-else class="section-card py-12 text-center text-slate-500 dark:text-slate-400">
      档案不存在或已被删除。
    </div>
  </div>
</template>

<script setup lang="ts">
import type { ApiContentStoryDetail } from '~/composables/useApi'
import { sync_resource } from '@shared/types/sync'

const route = useRoute()
const { content } = useApi()
const { user } = useAuth()
const runtime_config = useRuntimeConfig()

const story_id = computed(() => Number(route.params.id))
const is_admin = computed(() => Boolean(user.value?.is_admin))

const story = useState<ApiContentStoryDetail | null>(`content_story_view_${String(route.params.id)}`, () => null)
const loading = useState(`content_story_view_loading_${String(route.params.id)}`, () => false)

await useSyncedData<ApiContentStoryDetail>(
  computed(() => {
    const id = story_id.value
    return Number.isInteger(id) && id > 0 ? sync_resource('content_story', id) : null
  }),
  () => content.get_story(story_id.value),
  story,
  loading,
  {
    polling_interval: runtime_config.public.poll_interval_seconds * 1000,
  },
)

const event_entries = computed(() => {
  if (! story.value)
    return []
  return story.value.event_dates.map((date) => {
    const [year, month, day] = date.split('-')
    if (story.value!.event_precision === 'month') {
      return `${Number(year)} 年 ${Number(month)} 月`
    }
    return `${Number(year)} 年 ${Number(month)} 月 ${Number(day)} 日`
  })
})
</script>
