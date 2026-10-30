<template>
  <NuxtLink :to="story ? `/content/${story.id}` : `/content/draft-${draft!.id}/edit`" class="story-card watermark" :style="watermark_style">
    <span v-if="story?.cover" class="story-card-cover">
      <MyContentStoryCover
        :src="story_front_cover_url(static_url, story.cover, story.cover_url)"
        :alt="cover_alt(story.cover, story.cover_label, story.title)"
        :image="story.cover_image"
      />
    </span>
    <div class="story-card-body">
      <template v-if="story">
        <span class="story-card-title">
          <span>{{ story.title }}</span>
          <span
            v-if="pinned"
            class="ms-2 text-xs font-bold text-slate-400 dark:text-slate-500"
          ><MyIcon name="lucide:pin" class="me-0.5" /><span>置顶</span></span>
        </span>
        <span v-if="story.desc" class="story-card-desc">{{ story.desc }}</span>
        <div class="mt-2 w-full flex flex-wrap items-end gap-2">
          <span v-if="labels.length" class="flex flex-wrap justify-center gap-1">
            <MyBadge
              v-for="label in labels"
              :key="label"
              type="info"
              :outlined="! active_labels?.has(label)"
            >
              {{ label }}
            </MyBadge>
          </span>
          <span class="story-card-date ml-auto">
            {{ format_event_range(story.event_precision, story.event_dates, time_context.timezone) }}
          </span>
        </div>
      </template>
      <template v-else-if="draft">
        <span class="story-card-title">{{ draft.title }}</span>
        <div class="mt-2 w-full flex flex-wrap items-end gap-2">
          <MyBadge type="info" outlined>
            {{ draft.story_id ? '修改草稿' : '未发布' }}
          </MyBadge>
          <span class="story-card-date ml-auto">更新于 {{ format_event_entry('day', draft.updated_at, time_context.timezone) }}</span>
        </div>
      </template>
    </div>
  </NuxtLink>
</template>

<script setup lang="ts">
import type { ContentStorySummary } from '@shared/types/content'
import type { ContentDraftSummary } from '@shared/types/content-draft'
import { story_pinned, story_rating_rank } from '@shared/types/content'
import { cover_alt, story_front_cover_url } from '~/utils/content/attachment'
import { format_event_entry, format_event_range } from '~/utils/content/event'

const props = defineProps<{
  story?: ContentStorySummary
  draft?: ContentDraftSummary
  active_labels?: Set<string>
}>()

const static_url = useStaticUrl()
const time_context = useDisplayTimeContext()

const pinned = computed(() => story_pinned(props.story?.labels ?? []))
const rating_rank = computed(() => story_rating_rank(props.story?.labels ?? []))
const labels = computed(() => (props.story?.labels ?? []).filter(label => ! label.startsWith('#')))
const watermark_style = computed(() =>
  rating_rank.value
    ? { '--watermark-url': `url("${static_url(`imgs/ratings/${6 - rating_rank.value}.svg`)}")` }
    : {},
)
</script>

<style scoped>
/* Mini StoryHeader look: centered title/date/desc/labels stack on the card
   chrome; the tier SVG watermark comes from the shared .watermark class in
   global.css (driven by the inline --watermark-url).

   The card itself is unpadded and the text rows own the inset instead (same
   split as the MarkdownPreview reference cards), so a cover spans the card
   edge to edge without having to cancel a padding it does not know. */
.story-card {
  @apply flex w-full min-w-0 flex-col rounded-sm bg-slate-100 text-sm leading-5 transition-all duration-300 dark:bg-slate-800/50;
}

.story-card > *,
.story-card-body > * {
  @apply min-w-0 max-w-full;
}

.story-card-body {
  @apply flex w-full flex-col items-center gap-1 px-4 py-3;
}

.story-card:hover,
.story-card:focus-visible {
  @apply border-primary brightness-90;
}

/* Rows center as boxes via the body's items-center; no text-center, so a
   wrapped row's lines lean left inside the shrink-wrapped box. */
.story-card-title {
  @apply mt-0.5 break-words text-xl font-bold text-slate-800 dark:text-slate-100;
}

.story-card-date {
  @apply text-xs text-slate-400 dark:text-slate-500;
}

/* Cover sits at the very top of the card and takes its width, so the card's
   rounded corners are the image's corners. */
.story-card-cover {
  @apply relative w-full shrink-0 overflow-hidden rounded-t-sm bg-slate-200 dark:bg-slate-700;
}

.story-card-cover img {
  @apply m-0 block h-auto max-h-none w-full min-w-0;
}

.story-card-desc {
  @apply break-words text-sm text-slate-500 dark:text-slate-400;
}
</style>
