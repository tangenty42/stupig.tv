<template>
  <div>
    <div class="mb-3 flex items-center justify-between">
      <Button text size="small" aria-label="上个月" @click="shift_month(- 1)">
        <template #icon>
          <MyIcon name="lucide:chevron-left" />
        </template>
      </Button>
      <span class="font-medium">{{ month_label }}</span>
      <Button text size="small" aria-label="下个月" @click="shift_month(1)">
        <template #icon>
          <MyIcon name="lucide:chevron-right" />
        </template>
      </Button>
    </div>

    <div class="grid grid-cols-7 gap-1 text-center text-xs text-slate-400 dark:text-slate-500">
      <span v-for="day in week_labels" :key="day" class="py-1">{{ day }}</span>
    </div>

    <div class="grid grid-cols-7 gap-1">
      <template v-for="(cell, index) in cells" :key="index">
        <button
          v-if="cell.date"
          type="button"
          class="relative flex h-9 items-center justify-center rounded-sm text-sm transition-colors"
          :class="[
            cell.is_today ? 'font-bold text-brand-600 dark:text-brand-400' : 'text-slate-600 dark:text-slate-300',
            cell.date === selected_date ? 'bg-brand-100 dark:bg-brand-900/40' : 'hover:bg-slate-100 dark:hover:bg-slate-800',
          ]"
          @click="selected_date = cell.date"
        >
          {{ cell.day }}
          <span v-if="cell.count" class="absolute bottom-0.5 flex gap-0.5">
            <span
              v-for="dot in Math.min(cell.count, 3)"
              :key="dot"
              class="h-1 w-1 rounded-full bg-brand-500"
            />
          </span>
        </button>
        <span v-else />
      </template>
    </div>

    <div v-if="month_stories.length" class="mt-4">
      <div class="mb-2 text-xs font-medium text-slate-400 dark:text-slate-500">
        {{ month_label }}前后的事
      </div>
      <div class="space-y-1">
        <NuxtLink
          v-for="story in month_stories"
          :key="story.id"
          :to="`/content/${story.id}`"
          class="flex items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-slate-100 dark:hover:bg-slate-800"
        >
          <span class="flex shrink-0 items-center text-amber-400">
            <MyIcon
              v-for="star in story.rating"
              :key="star"
              name="lucide:star"
              class="fill-amber-400 text-xs"
            />
          </span>
          <span class="truncate">{{ story.title }}</span>
        </NuxtLink>
      </div>
    </div>

    <div v-if="selected_date" class="mt-4">
      <div class="mb-2 text-xs font-medium text-slate-400 dark:text-slate-500">
        {{ selected_date }} 的事
      </div>
      <div v-if="selected_day_stories.length" class="space-y-1">
        <NuxtLink
          v-for="story in selected_day_stories"
          :key="story.id"
          :to="`/content/${story.id}`"
          class="flex items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-slate-100 dark:hover:bg-slate-800"
        >
          <span class="flex shrink-0 items-center text-amber-400">
            <MyIcon
              v-for="star in story.rating"
              :key="star"
              name="lucide:star"
              class="fill-amber-400 text-xs"
            />
          </span>
          <span class="truncate">{{ story.title }}</span>
        </NuxtLink>
      </div>
      <div v-else class="px-2 text-sm text-slate-400 dark:text-slate-500">
        这一天风平浪静。
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { ContentStorySummary } from '@shared/types/content'

const props = defineProps<{
  stories: ContentStorySummary[]
}>()

const week_labels = ['一', '二', '三', '四', '五', '六', '日']

const displayed_month = ref(localize_date().startOf('month'))
const selected_date = ref<string | null>(localize_date().format('YYYY-MM-DD'))

const month_label = computed(() => displayed_month.value.format('YYYY 年 M 月'))

const day_story_map = computed(() => {
  const map = new Map<string, ContentStorySummary[]>()
  for (const story of props.stories) {
    if (story.event_precision !== 'day')
      continue
    for (const date of story.event_dates) {
      const list = map.get(date) ?? []
      list.push(story)
      map.set(date, list)
    }
  }
  return map
})

const month_stories = computed(() => {
  const month_key = displayed_month.value.format('YYYY-MM')
  return props.stories.filter(story =>
    story.event_precision === 'month' && story.event_dates.some(date => date.startsWith(month_key)),
  )
})

const selected_day_stories = computed(() => {
  if (! selected_date.value)
    return []
  return day_story_map.value.get(selected_date.value) ?? []
})

const cells = computed(() => {
  const month_start = displayed_month.value.startOf('month')
  const today = localize_date().format('YYYY-MM-DD')
  // Monday-first: day() returns 0 for Sunday.
  const leading = (month_start.day() + 6) % 7
  const days_in_month = month_start.daysInMonth()

  const list: { date: string | null, day: number, count: number, is_today: boolean }[] = []
  for (let i = 0; i < leading; i ++) {
    list.push({ date: null, day: 0, count: 0, is_today: false })
  }
  for (let day = 1; day <= days_in_month; day ++) {
    const date = month_start.date(day).format('YYYY-MM-DD')
    list.push({
      date,
      day,
      count: day_story_map.value.get(date)?.length ?? 0,
      is_today: date === today,
    })
  }
  return list
})

function shift_month(delta: number) {
  displayed_month.value = displayed_month.value.add(delta, 'month')
}
</script>
