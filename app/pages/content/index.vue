<template>
  <div class="pb-12 pt-8">
    <MyHeightSection tag="section" class="section-card-collapse">
      <div class="flex flex-wrap items-center justify-between gap-4">
        <h1 class="flex flex-wrap items-baseline gap-x-4">
          <span class="font-normal text-[60%]">{{ stories?.length ?? 0 }} 份の</span>
          <span>蠢猪档案！</span>
        </h1>
        <Button
          v-if="can_manage_content"
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

      <div v-else-if="visible_stories.length">
        <div class="flex flex-col gap-4 sm:hidden">
          <MyContentStoryCard
            v-for="story in visible_stories"
            :key="story.id"
            :story="story"
            :active_labels="active_labels"
          />
        </div>
        <!-- Two independent flex columns filled alternately, so the waterfall
             reads row-major (1|2, 3|4, …) instead of CSS columns' 1|4, 2|5. -->
        <div class="hidden items-start gap-4 sm:grid sm:grid-cols-2">
          <div
            v-for="(column, index) in story_columns"
            :key="index"
            class="flex min-w-0 flex-col gap-4"
          >
            <MyContentStoryCard
              v-for="story in column"
              :key="story.id"
              :story="story"
              :active_labels="active_labels"
            />
          </div>
        </div>
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
import { has_permission } from '@shared/permissions'
import { story_pinned, story_rating_rank } from '@shared/types/content'
import { sync_resource } from '@shared/types/sync'

const { content } = useApi()
const { user } = useAuth()

const can_manage_content = computed(() => has_permission(user.value, 'content_manage', 'full'))

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

const story_columns = computed(() => {
  const columns: ContentStorySummary[][] = [[], []]
  visible_stories.value.forEach((story, index) => columns[index % 2]!.push(story))
  return columns
})
</script>
