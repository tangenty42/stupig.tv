<template>
  <div>
    <div v-if="stories?.length || activeLabels.size" class="mb-4 flex flex-wrap items-center gap-1.5">
      <MyBadge
        v-for="label in all_labels"
        :key="label"
        type="info"
        :outlined="! activeLabels.has(label)"
        button
        @click="$emit('toggle-label', label)"
      >
        {{ label }}
      </MyBadge>
      <MyBadge
        v-if="activeLabels.size"
        button
        @click="$emit('clear-labels')"
      >
        清除
      </MyBadge>
      <button
        v-if="stories?.length"
        type="button"
        class="ml-auto rounded-full"
        aria-label="排序"
        :aria-describedby="sort_mode_id"
        :aria-pressed="sortByRating"
        @click="$emit('update:sortByRating', ! sortByRating)"
      >
        <MyBadge button>
          <span>
            <MyIcon :name="sortByRating ? 'lucide:star' : 'lucide:calendar-days'" class="mr-1" />排序：<span :id="sort_mode_id">{{ sortByRating ? '按评分' : '按时间' }}</span>
          </span>
        </MyBadge>
      </button>
    </div>
    <div v-else-if="loading && ! stories" class="mb-4 flex justify-end" aria-hidden="true">
      <Skeleton width="6rem" height="1.625rem" class="rounded-full" />
    </div>

    <div v-if="loading && ! stories" class="grid grid-cols-1 gap-4 sm:grid-cols-2" role="status" aria-label="正在加载已发布档案">
      <Skeleton v-for="i in 3" :key="i" height="5.125rem" class="rounded-sm" />
    </div>

    <MyContentListLoadError v-else-if="! stories" class="py-8" @retry="$emit('retry')" />

    <div v-else-if="visible_stories.length">
      <div class="flex flex-col gap-4 sm:hidden">
        <MyContentStoryCard
          v-for="story in visible_stories"
          :key="story.id"
          :story="story"
          :active_labels="activeLabels"
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
            :active_labels="activeLabels"
          />
        </div>
      </div>
    </div>

    <div v-else class="py-8 text-center text-sm text-slate-500 dark:text-slate-400">
      {{ stories.length ? '没有符合筛选条件的档案~' : '还没有档案~' }}
    </div>
  </div>
</template>

<script setup lang="ts">
import type { ContentStorySummary } from '@shared/types/content'
import { story_pinned, story_rating_rank } from '@shared/types/content'
import { visible_story_labels } from '~/features/content/story-presentation'

// Filters live in the page so they survive switching to drafts and back.
const props = defineProps<{
  stories: ContentStorySummary[] | null
  loading: boolean
  activeLabels: Set<string>
  sortByRating: boolean
}>()
defineEmits<{
  'retry': []
  'toggle-label': [label: string]
  'clear-labels': []
  'update:sortByRating': [value: boolean]
}>()
const sort_mode_id = useId()

function visible_labels(story: ContentStorySummary) {
  return visible_story_labels(story.labels)
}

const all_labels = computed(() => {
  const labels = new Set<string>()
  for (const story of props.stories ?? []) {
    for (const label of visible_labels(story))
      labels.add(label)
  }
  return [... labels].sort((a, b) => a.localeCompare(b, 'zh-CN'))
})

const visible_stories = computed(() => {
  let list = props.stories ?? []
  if (props.activeLabels.size) {
    list = list.filter(
      story =>
        visible_labels(story).some(label => props.activeLabels.has(label)),
    )
  }
  const compare = props.sortByRating
    ? (a: ContentStorySummary, b: ContentStorySummary) =>
        story_rating_rank(b.labels) - story_rating_rank(a.labels)
        || b.event_dates.join(',').localeCompare(a.event_dates.join(','))
    : (a: ContentStorySummary, b: ContentStorySummary) =>
        Number(b.event_dates.length === 0) - Number(a.event_dates.length === 0)
        || b.event_dates.join(',').localeCompare(a.event_dates.join(','))
  return list.toSorted(
    (a, b) =>
      Number(story_pinned(b.labels)) - Number(story_pinned(a.labels))
      || compare(a, b)
      // Ties ignore the server's updated_at order, which reference rewrites touch.
      || a.title.localeCompare(b.title, 'zh-CN'),
  )
})

const story_columns = computed(() => {
  const columns: ContentStorySummary[][] = [[], []]
  visible_stories.value.forEach((story, index) => columns[index % 2]!.push(story))
  return columns
})
</script>
