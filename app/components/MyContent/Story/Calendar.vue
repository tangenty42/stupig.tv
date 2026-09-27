<template>
  <div>
    <div class="mb-3 flex items-center justify-center gap-2">
      <Button text size="small" severity="secondary" class="!px-0 !py-0.5" aria-label="上个月" :disabled="! can_go_prev" @click="shift_month(- 1)">
        <template #icon>
          <MyIcon name="lucide:chevron-left" />
        </template>
      </Button>
      <span class="py-1 font-medium">{{ month_label }}</span>
      <Button text size="small" severity="secondary" class="!px-0 !py-0.5" aria-label="下个月" :disabled="! can_go_next" @click="shift_month(1)">
        <template #icon>
          <MyIcon name="lucide:chevron-right" />
        </template>
      </Button>
    </div>

    <div ref="body_wrapper" :style="body_min_height === null ? undefined : { minHeight: `${body_min_height}px` }">
      <div class="overflow-x-auto pb-2">
        <div class="min-w-[56rem] overflow-hidden rounded-sm border border-slate-200 dark:border-slate-700">
          <div class="grid grid-cols-7 border-b border-slate-200 bg-slate-50 text-center text-xs text-slate-500 dark:border-slate-700 dark:bg-slate-800/60 dark:text-slate-400">
            <span
              v-for="(day, index) in week_labels"
              :key="day"
              class="border-slate-200 py-1.5 dark:border-slate-700"
              :class="index < 6 ? 'border-r' : ''"
            >
              {{ day }}
            </span>
          </div>

          <div
            v-for="row in rows"
            :key="row.key"
            class="relative border-b border-slate-200 last:border-b-0 dark:border-slate-700"
          >
            <div class="grid grid-cols-7">
              <div
                v-for="(cell, index) in row.cells"
                :key="index"
                class="border-slate-200 p-0.5 dark:border-slate-700 sm:p-1"
                :class="[
                  index < 6 ? 'border-r' : '',
                  cell.date
                    ? (cell.is_today ? 'bg-brand-50/70 dark:bg-brand-900/20' : '')
                    : 'bg-slate-50/70 dark:bg-slate-800/30',
                ]"
                :style="{ minHeight: `${row.height}px` }"
              >
                <div v-if="cell.date" class="flex h-5 items-start justify-end">
                  <span
                    class="px-0.5 text-xs leading-5"
                    :class="cell.is_today ? 'font-bold text-brand-600 dark:text-brand-400' : 'text-slate-500 dark:text-slate-400'"
                  >
                    {{ cell.day }}
                  </span>
                </div>
              </div>
            </div>

            <div class="pointer-events-none absolute inset-0">
              <NuxtLink
                v-for="segment in row.segments"
                :key="segment.event.story.id"
                :to="`/content/${segment.event.story.id}`"
                :title="segment.event.story.title"
                class="pointer-events-auto absolute flex items-center text-xs text-white transition-[opacity,filter]"
                :class="[
                  bar_state_class(segment),
                ]"
                :style="segment_style(segment)"
                @mouseenter="hovered_id = segment.event.story.id"
                @mouseleave="hovered_id = null"
              >
                <span
                  class="pointer-events-none absolute inset-y-0"
                  :class="[
                    segment_background_class(segment),
                    ! segment.stretch_back && ! segment.continues_before ? 'rounded-l-full' : '',
                    ! segment.stretch_forward && ! segment.continues_after ? 'rounded-r-full' : '',
                  ]"
                  :style="{
                    left: segment.stretch_back ? `${MONTH_STRETCH}px` : '0',
                    right: segment.stretch_forward ? `${MONTH_STRETCH}px` : '0',
                  }"
                />
                <span
                  v-if="segment.stretch_back"
                  class="pointer-events-none absolute inset-y-0 left-0 rounded-tl-full"
                  :class="segment_background_class(segment)"
                  :style="{ width: `${MONTH_STRETCH}px` }"
                />
                <span
                  v-if="segment.stretch_forward"
                  class="pointer-events-none absolute inset-y-0 right-0 rounded-br-full"
                  :class="segment_background_class(segment)"
                  :style="{ width: `${MONTH_STRETCH}px` }"
                />

                <MyIcon v-if="segment.stretch_back" name="lucide:chevrons-left" class="relative ml-3 shrink-0 text-sm" />
                <span class="relative min-w-0 truncate px-1.5">{{ segment.event.story.title }}</span>
                <MyIcon v-if="segment.stretch_forward" name="lucide:chevrons-right" class="relative ml-auto mr-3 shrink-0 text-sm" />
              </NuxtLink>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { ContentStorySummary } from '@shared/types/content'
import type { Dayjs } from 'dayjs'
import { format_event_entry } from '~/utils/content/event'

interface CalendarEvent {
  story: ContentStorySummary
  /** Inclusive day range. */
  start: Dayjs
  end: Dayjs
  color_class: string
}

interface CalendarCell {
  date: Dayjs | null
  day: number
  is_today: boolean
}

interface CalendarSegment {
  event: CalendarEvent
  start_col: number
  end_col: number
  lane: number
  /** Event started in a previous month: the bar pokes out to the left with the title on it. */
  stretch_back: boolean
  /** Event ends in a later month: the bar pokes out to the right with a » marker. */
  stretch_forward: boolean
  /** Segment continues from the previous week of the same month: flush left edge, no title. */
  continues_before: boolean
  /** Segment continues into the next week of the same month: flush right edge. */
  continues_after: boolean
}

interface CalendarRow {
  key: string
  cells: CalendarCell[]
  segments: CalendarSegment[]
  height: number
}

const props = withDefaults(defineProps<{
  stories: ContentStorySummary[]
  highlight_id?: number | null
  initial_month?: string | null
}>(), {
  highlight_id: null,
  initial_month: null,
})

const week_labels = ['一', '二', '三', '四', '五', '六', '日']

// Bar colors ignore ratings: events cycle through this palette in start-date
// order, so neighboring bars rarely share a color.
const bar_palette = [
  'bg-rose-500',
  'bg-sky-500',
  'bg-amber-500',
  'bg-violet-500',
  'bg-emerald-500',
  'bg-pink-500',
]

// Fixed pixel metrics keep the lane math exact on every device width.
const DAY_HEAD_HEIGHT = 28
const LANE_HEIGHT = 28
const BAR_HEIGHT = 24
const ROW_BOTTOM_PADDING = 6
const EDGE_INSET = 2
const MONTH_STRETCH = 28
const COL_SPAN = 100 / 7

const events = computed<CalendarEvent[]>(() => {
  const list: CalendarEvent[] = []
  for (const story of props.stories) {
    const dates = story.event_dates
      .map(date => localize_date(date, true))
      .filter(date => date.isValid())
      .sort((a, b) => a.valueOf() - b.valueOf())
    const start = dates[0]
    const last = dates[dates.length - 1]
    if (! start || ! last)
      continue
    list.push({
      story,
      start,
      end: story.event_precision === 'month' ? last.endOf('month') : last,
      color_class: '',
    })
  }
  list.sort((a, b) => a.start.diff(b.start) || a.end.diff(b.end) || a.story.id - b.story.id)
  list.forEach((event, index) => {
    event.color_class = bar_palette[index % bar_palette.length]!
  })
  return list
})

// Month navigation stays within the months touched by any event — or, when a
// story is highlighted (detail page), within that event's own start/end months.
const bound_event = computed(() =>
  props.highlight_id === null ? null : (events.value.find(event => event.story.id === props.highlight_id) ?? null),
)

const min_month = computed(() => (bound_event.value ?? events.value[0])?.start.startOf('month') ?? null)
const max_month = computed(() => {
  if (bound_event.value)
    return bound_event.value.end.startOf('month')
  let max: Dayjs | null = null
  for (const event of events.value) {
    const month = event.end.startOf('month')
    if (max === null || month.isAfter(max))
      max = month
  }
  return max
})

const displayed_month = ref(parse_initial_month())

const month_label = computed(() => format_event_entry('month', displayed_month.value))

// Hovering any segment applies the hover effect to every segment of that event.
const hovered_id = ref<number | null>(null)

function parse_initial_month() {
  if (props.initial_month) {
    const initial_month = localize_date(props.initial_month, true)
    if (initial_month.isValid())
      return initial_month.startOf('month')
  }
  return max_month.value ?? localize_date().startOf('month')
}

const can_go_prev = computed(() => min_month.value !== null && displayed_month.value.isAfter(min_month.value, 'month'))
const can_go_next = computed(() => max_month.value !== null && displayed_month.value.isBefore(max_month.value, 'month'))

function clamp_displayed_month() {
  if (min_month.value !== null && displayed_month.value.isBefore(min_month.value, 'month'))
    displayed_month.value = min_month.value
  else if (max_month.value !== null && displayed_month.value.isAfter(max_month.value, 'month'))
    displayed_month.value = max_month.value
}

// Until a month is pinned (initial_month prop or manual navigation), follow the
// last reachable month once the bounds are known.
const month_pinned = ref(Boolean(props.initial_month && localize_date(props.initial_month, true).isValid()))

watch([min_month, max_month], () => {
  if (! month_pinned.value && max_month.value !== null)
    displayed_month.value = max_month.value
  else
    clamp_displayed_month()
}, { immediate: true })

function build_rows(month: Dayjs): CalendarRow[] {
  const month_start = month.startOf('month')
  const month_last = month_start.endOf('month')
  const today = localize_date()
  // Monday-first: day() returns 0 for Sunday.
  const leading = (month_start.day() + 6) % 7
  const days_in_month = month_start.daysInMonth()

  const cells: CalendarCell[] = []
  for (let i = 0; i < leading; i ++)
    cells.push({ date: null, day: 0, is_today: false })
  for (let day = 1; day <= days_in_month; day ++) {
    const date = month_start.date(day)
    cells.push({ date, day, is_today: date.isSame(today, 'day') })
  }
  while (cells.length % 7 !== 0)
    cells.push({ date: null, day: 0, is_today: false })

  const row_count = cells.length / 7
  const result: CalendarRow[] = []
  for (let row_index = 0; row_index < row_count; row_index ++) {
    const row_cells = cells.slice(row_index * 7, row_index * 7 + 7)
    const segments: CalendarSegment[] = []

    for (const event of events.value) {
      if (event.end.isBefore(month_start, 'day') || event.start.isAfter(month_last, 'day'))
        continue
      let start_col = - 1
      let end_col = - 1
      for (let col = 0; col < 7; col ++) {
        const date = row_cells[col]!.date
        if (date && ! date.isBefore(event.start, 'day') && ! date.isAfter(event.end, 'day')) {
          if (start_col === - 1)
            start_col = col
          end_col = col
        }
      }
      if (start_col === - 1)
        continue

      const stretch_back = event.start.isBefore(month_start, 'day') && row_index === 0
      const stretch_forward = event.end.isAfter(month_last, 'day') && row_index === row_count - 1
      segments.push({
        event,
        start_col,
        end_col,
        lane: 0,
        stretch_back,
        stretch_forward,
        continues_before: ! row_cells[start_col]!.date!.isSame(event.start, 'day') && ! stretch_back,
        continues_after: ! row_cells[end_col]!.date!.isSame(event.end, 'day') && ! stretch_forward,
      })
    }

    // Greedy lane packing: earliest start first, wider segments first.
    segments.sort((a, b) => a.start_col - b.start_col || (b.end_col - b.start_col) - (a.end_col - a.start_col))
    const lane_ends: number[] = []
    for (const segment of segments) {
      let lane = lane_ends.findIndex(lane_end => lane_end < segment.start_col)
      if (lane === - 1) {
        lane = lane_ends.length
        lane_ends.push(segment.end_col)
      }
      else {
        lane_ends[lane] = segment.end_col
      }
      segment.lane = lane
    }

    result.push({
      key: row_cells.find(cell => cell.date)?.date?.format('YYYY-MM-DD') ?? `row-${row_index}`,
      cells: row_cells,
      segments,
      height: DAY_HEAD_HEIGHT + lane_ends.length * LANE_HEIGHT + ROW_BOTTOM_PADDING,
    })
  }
  return result
}

const rows = computed(() => build_rows(displayed_month.value))

// Sticky floor: measured from the rendered wrapper (header, borders, padding
// and the horizontal scrollbar included) after each month renders, and only
// grows — switching months never shrinks the calendar and chatters the layout.
const body_wrapper = ref<HTMLElement | null>(null)
const body_min_height = ref<number | null>(null)
function measure_body_floor() {
  const el = body_wrapper.value
  if (! el)
    return
  if (body_min_height.value === null || el.offsetHeight > body_min_height.value)
    body_min_height.value = el.offsetHeight
}
// Template refs are not yet bound when an immediate post watcher fires.
onMounted(measure_body_floor)
watch(rows, measure_body_floor, { flush: 'post' })

function bar_state_class(segment: CalendarSegment) {
  const hovered = hovered_id.value === segment.event.story.id
  if (props.highlight_id === null)
    return hovered ? 'brightness-90' : ''
  if (segment.event.story.id === props.highlight_id)
    return 'z-10 font-bold dark:text-slate-800'
  return hovered ? 'opacity-100' : 'opacity-30'
}

function segment_background_class(segment: CalendarSegment) {
  if (segment.event.story.id === props.highlight_id)
    return '!bg-slate-700/80 dark:!bg-slate-200/80'
  return segment.event.color_class
}

function segment_style(segment: CalendarSegment) {
  const inset_left = segment.continues_before ? 0 : EDGE_INSET - (segment.stretch_back ? MONTH_STRETCH : 0)
  const inset_right = segment.continues_after ? 0 : EDGE_INSET - (segment.stretch_forward ? MONTH_STRETCH : 0)
  const left = (segment.start_col * COL_SPAN).toFixed(4)
  const width = ((segment.end_col - segment.start_col + 1) * COL_SPAN).toFixed(4)
  return {
    left: `calc(${left}% + ${inset_left}px)`,
    width: `calc(${width}% - ${inset_left + inset_right}px)`,
    top: `${DAY_HEAD_HEIGHT + segment.lane * LANE_HEIGHT}px`,
    height: `${BAR_HEIGHT}px`,
  }
}

function shift_month(delta: number) {
  if (delta < 0 && ! can_go_prev.value)
    return
  if (delta > 0 && ! can_go_next.value)
    return
  month_pinned.value = true
  displayed_month.value = displayed_month.value.add(delta, 'month')
}
</script>
