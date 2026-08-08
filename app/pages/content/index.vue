<template>
  <div class="pb-12 pt-8">
    <MyHeightSection tag="section" class="section-card-collapse">
      <div class="flex flex-wrap items-center justify-between gap-4">
        <h1 class="flex flex-wrap items-baseline gap-x-4">
          <span class="font-normal text-[60%]">{{ stories?.length ?? 0 }} 份の</span>
          <span>蠢猪档案！</span>
        </h1>
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

    <MyHeightSection tag="section" class="section-card-collapse mt-12">
      <div v-if="all_labels.length" class="mb-4 flex flex-wrap items-center gap-1.5">
        <MyBadge
          v-for="label in all_labels"
          :key="label"
          type="info"
          :outlined="! active_labels.has(label)"
          button
          @click="toggle_label(label)"
        >
          {{ label }}
        </MyBadge>
        <MyBadge
          v-if="active_labels.size"
          button
          @click="active_labels.clear()"
        >
          清除
        </MyBadge>
        <MyBadge
          button
          class="ml-auto"
          @click="sort_by_rating = ! sort_by_rating"
        >
          {{ sort_by_rating ? '按评分排序' : '按时间顺序排序' }}
        </MyBadge>
      </div>

      <div v-if="loading && ! stories" class="space-y-3">
        <Skeleton v-for="i in 3" :key="i" height="3.5rem" />
      </div>

      <div v-else-if="visible_stories.length" class="flex flex-col gap-3">
        <NuxtLink
          v-for="story in visible_stories"
          :key="story.id"
          :to="`/content/${story.id}`"
          class="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-1 p-3.5 rounded-sm bg-slate-100/50 dark:bg-slate-800/50 transition-[filter] hover:brightness-90 sm:grid-cols-[auto_minmax(0,1fr)_auto_auto] sm:gap-x-4"
        >
          <MyContentRating :rating="story.labels" />
          <span class="min-w-0 break-words font-medium text-slate-700 dark:text-slate-200 sm:truncate">
            <span v-if="story_pinned(story.labels)" class="inline-flex items-center gap-1 mr-2 text-slate-400 dark:text-slate-500">
              <span>置顶</span>
              <MyIcon name="lucide:pin" />
            </span>
            <span>{{ story.title }}</span>
          </span>
          <span v-if="visible_labels(story).length" class="col-start-2 flex flex-wrap gap-1 sm:col-start-3">
            <MyBadge
              v-for="label in visible_labels(story)"
              :key="label"
              type="info"
              :outlined="! active_labels.has(label)"
            >
              {{ label }}
            </MyBadge>
          </span>
          <span class="col-start-2 text-xs text-slate-400 dark:text-slate-500 text-end sm:col-start-4">
            {{ format_event_range(story.event_precision, story.event_dates) }}
          </span>
          <p v-if="story.desc" class="col-start-2 min-w-0 break-words text-sm text-slate-500 dark:text-slate-400 sm:col-span-3 sm:col-start-2">
            {{ story.desc }}
          </p>
          <img
            v-if="story.cover"
            :src="story_front_cover_url(story.cover, story.id)"
            :alt="cover_alt(story.cover, story.cover_label, story.title)"
            loading="lazy"
            class="col-start-2 my-1 max-h-40 w-auto rounded-sm sm:col-span-3 sm:col-start-2"
          >
        </NuxtLink>
      </div>

      <div v-else class="py-8 text-center text-sm text-slate-500 dark:text-slate-400">
        {{ stories?.length ? '没有符合筛选条件的档案~' : '还没有档案~' }}
      </div>
    </MyHeightSection>

    <MyDivider class="mt-24">
      事件日历
    </MyDivider>

    <MyHeightSection tag="section" class="section-card-collapse mt-6">
      <MyContentStoryCalendar :stories="stories ?? []" />
    </MyHeightSection>
  </div>
</template>

<script setup lang="ts">
import type { ContentStorySummary } from '@shared/types/content'
import { story_pinned, story_rating_rank } from '@shared/types/content'
import { sync_resource } from '@shared/types/sync'
import { cover_alt, story_front_cover_url } from '~/utils/content/attachment'
import { format_event_range } from '~/utils/content/event'

const { content } = useApi()
const { user } = useAuth()

const is_admin = computed(() => Boolean(user.value?.is_admin))

const stories = useState<ContentStorySummary[] | null>('content_stories', () => null)
const loading = useState('content_stories_loading', () => false)

await useSyncedData<ContentStorySummary[]>(
  computed(() => sync_resource('content_stories', 'all')),
  () => content.list_stories(),
  stories,
  loading,
)

const active_labels = reactive(new Set<string>())
const sort_by_rating = ref(false)

function visible_labels(story: ContentStorySummary) {
  return story.labels.filter(label => ! label.startsWith('#'))
}

const all_labels = computed(() => {
  const labels = new Set<string>()
  for (const story of stories.value ?? []) {
    for (const label of visible_labels(story))
      labels.add(label)
  }
  return [... labels].sort((a, b) => a.localeCompare(b, 'zh-CN'))
})

const visible_stories = computed(() => {
  let list = stories.value ?? []
  if (active_labels.size) {
    list = list.filter(
      story =>
        visible_labels(story).some(label => active_labels.has(label)),
    )
  }
  const compare = sort_by_rating.value
    ? (a: ContentStorySummary, b: ContentStorySummary) =>
        story_rating_rank(b.labels) - story_rating_rank(a.labels)
        || b.event_dates.join(',').localeCompare(a.event_dates.join(','))
    : (a: ContentStorySummary, b: ContentStorySummary) =>
        b.event_dates.join(',').localeCompare(a.event_dates.join(','))
  return list.toSorted(
    (a, b) =>
      Number(story_pinned(b.labels)) - Number(story_pinned(a.labels))
      || compare(a, b),
  )
})

function toggle_label(label: string) {
  if (! active_labels.delete(label))
    active_labels.add(label)
}
</script>
