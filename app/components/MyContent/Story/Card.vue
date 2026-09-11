<template>
  <NuxtLink :to="`/content/${story.id}`" class="story-card watermark" :style="watermark_style">
    <span v-if="story.cover" class="story-card-cover">
      <img
        :src="story_front_cover_url(static_url, story.cover, story.cover_url)"
        :alt="cover_alt(story.cover, story.cover_label, story.title)"
        loading="lazy"
        referrerpolicy="no-referrer"
      >
    </span>
    <span class="story-card-title">
      <span v-if="pinned" class="mr-1 inline-flex items-center gap-0.5 align-baseline text-xs font-bold text-slate-400 dark:text-slate-500">
        <MyIcon name="lucide:pin" />
        <span>置顶</span>
      </span>
      <span>{{ story.title }}</span>
    </span>
    <span class="story-card-date">
      {{ format_event_range(story.event_precision, story.event_dates) }}
    </span>
    <span v-if="story.desc" class="story-card-desc">{{ story.desc }}</span>
    <span v-if="labels.length" class="mt-1 flex flex-wrap justify-center gap-1">
      <MyBadge
        v-for="label in labels"
        :key="label"
        type="info"
        :outlined="! active_labels?.has(label)"
      >
        {{ label }}
      </MyBadge>
    </span>
  </NuxtLink>
</template>

<script setup lang="ts">
import type { ContentStorySummary } from '@shared/types/content'
import { story_pinned, story_rating_rank } from '@shared/types/content'
import { cover_alt, story_front_cover_url } from '~/utils/content/attachment'
import { format_event_range } from '~/utils/content/event'

const props = defineProps<{
  story: ContentStorySummary
  active_labels?: Set<string>
}>()

const static_url = useStaticUrl()

const pinned = computed(() => story_pinned(props.story.labels))
const rating_rank = computed(() => story_rating_rank(props.story.labels))
const labels = computed(() => props.story.labels.filter(label => ! label.startsWith('#')))
const watermark_style = computed(() =>
  rating_rank.value
    ? { '--watermark-url': `url("${static_url(`imgs/ratings/${6 - rating_rank.value}.svg`)}")` }
    : {},
)
</script>

<style scoped>
/* Mini StoryHeader look: centered title/date/desc/labels stack on the dashed
   card chrome; the tier SVG watermark comes from the shared .watermark
   class in global.css (driven by the inline --watermark-url). */
.story-card {
  @apply flex w-full min-w-0 flex-col items-center gap-1 rounded-sm border border-dashed border-slate-300 bg-slate-50/60 px-3 py-4 text-sm leading-5 shadow-none transition-all duration-300 dark:border-slate-600 dark:bg-slate-800/40;
}

.story-card > * {
  @apply min-w-0 max-w-full;
}

.story-card:hover,
.story-card:focus-visible {
  @apply border-primary brightness-90;
}

/* Rows center as boxes via the card's items-center; no text-center, so a
   wrapped row's lines lean left inside the shrink-wrapped box. */
.story-card-title {
  @apply my-0.5 break-words text-xl font-bold text-slate-800 dark:text-slate-100;
}

.story-card-date {
  @apply text-xs text-slate-400 dark:text-slate-500;
}

/* Cover sits at the very top of the card (same as the MarkdownPreview
   reference card), spilling 1px past the card's padding so the dashed top
   and side borders fold behind it (allowed by .watermark's clip margin);
   max-w-none overrides the generic children's cap so the bleed applies. */
.story-card-cover {
  @apply relative -mx-[calc(0.75rem_+_1px)] -mt-[calc(1rem_+_1px)] mb-1 w-[calc(100%_+_1.5rem_+_2px)] max-w-none shrink-0 overflow-hidden rounded-t-sm bg-slate-200 dark:bg-slate-700;
}

.story-card-cover img {
  @apply m-0 block h-auto max-h-none w-full min-w-0;
}

.story-card-desc {
  @apply mt-1 break-words text-sm text-slate-500 dark:text-slate-400;
}
</style>
