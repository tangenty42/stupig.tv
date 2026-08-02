<template>
  <div class="space-y-6 pb-12 pt-8">
    <MyHeightSection tag="section" class="section-card-collapse">
      <div class="flex flex-wrap items-center justify-between gap-4">
        <h1>蠢猪档案</h1>
        <Button
          v-if="is_admin"
          size="small"
          label="新建档案"
          @click="navigateTo('/content/new/edit')"
        >
          <template #icon>
            <MyIcon name="lucide:plus" />
          </template>
        </Button>
      </div>
    </MyHeightSection>

    <div class="grid grid-cols-1 items-start gap-6 lg:grid-cols-3">
      <MyHeightSection tag="section" class="section-card lg:col-span-1">
        <h2 class="mb-3">
          事件日历
        </h2>
        <ClientOnly>
          <MyContentStoryCalendar :stories="stories ?? []" />
          <template #fallback>
            <Skeleton height="16rem" />
          </template>
        </ClientOnly>
      </MyHeightSection>

      <MyHeightSection tag="section" class="section-card lg:col-span-2">
        <div class="mb-4 flex items-center justify-between">
          <h2>全部档案</h2>
          <span class="text-sm text-slate-500 dark:text-slate-400">共 {{ stories?.length ?? 0 }} 篇</span>
        </div>

        <div v-if="loading && ! stories" class="space-y-3">
          <Skeleton v-for="i in 3" :key="i" height="3.5rem" />
        </div>

        <div v-else-if="stories?.length" class="divide-y divide-slate-100 dark:divide-slate-800">
          <NuxtLink
            v-for="story in stories"
            :key="story.id"
            :to="`/content/${story.id}`"
            class="group flex flex-wrap items-center gap-x-4 gap-y-1 py-3"
          >
            <span class="flex min-w-16 shrink-0 items-center text-amber-400" :title="`评分 ${story.rating}`">
              <MyIcon
                v-for="star in story.rating"
                :key="star"
                name="lucide:star"
                class="fill-amber-400"
              />
            </span>
            <span class="min-w-0 flex-1 truncate font-medium text-slate-800 group-hover:underline dark:text-slate-100">
              {{ story.title }}
            </span>
            <span class="flex flex-wrap gap-1">
              <span
                v-for="entry in format_event_entries(story)"
                :key="entry"
                class="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-500 dark:bg-slate-800 dark:text-slate-400"
              >
                {{ entry }}
              </span>
            </span>
            <span class="text-xs text-slate-400 dark:text-slate-500">
              <ClientOnly>更新于 {{ datetime_format(story.updated_at) }}</ClientOnly>
            </span>
          </NuxtLink>
        </div>

        <div v-else class="py-8 text-center text-sm text-slate-500 dark:text-slate-400">
          还没有档案，一片空白。
        </div>
      </MyHeightSection>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { ContentStorySummary } from '@shared/types/content'
import { sync_resource } from '@shared/types/sync'

const { content } = useApi()
const { user } = useAuth()
const runtime_config = useRuntimeConfig()

const is_admin = computed(() => Boolean(user.value?.is_admin))

const stories = useState<ContentStorySummary[] | null>('content_stories', () => null)
const loading = useState('content_stories_loading', () => false)

await useSyncedData<ContentStorySummary[]>(
  computed(() => sync_resource('content_stories', 'all')),
  () => content.list_stories(),
  stories,
  loading,
  {
    polling_interval: runtime_config.public.poll_interval_seconds * 1000,
  },
)

function format_event_entries(story: ContentStorySummary) {
  return story.event_dates.map((date) => {
    if (story.event_precision === 'month') {
      const [year, month] = date.split('-')
      return `${Number(year)} 年 ${Number(month)} 月`
    }
    const [year, month, day] = date.split('-')
    return `${Number(year)}/${Number(month)}/${Number(day)}`
  })
}
</script>
