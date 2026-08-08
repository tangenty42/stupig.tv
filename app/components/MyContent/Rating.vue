<template>
  <span class="rating" :class="`rating-${tier}`">{{ tier }}</span>
</template>

<script setup lang="ts">
import type { ContentRatingInput } from '@shared/types/content'
import { story_rating } from '@shared/types/content'

const props = defineProps<{
  /** Tier name, rating label ('#夯'), labels array, or null. */
  rating: ContentRatingInput
}>()

const tier = computed(() => story_rating(props.rating))
</script>

<style scoped>
  .rating {
    @apply
      inline-flex
      shrink-0
      items-center
      rounded-tl-full
      rounded-br-full
      px-4
      py-2
      text-xs
      font-bold
      text-white;
  }
  :global(.rating-难评) {
    @apply bg-slate-400;
  }
  :global(.dark .rating-难评) {
    @apply bg-slate-500;
  }
  :global(.rating-拉完了) {
    @apply bg-gray-300;
  }
  :global(.dark .rating-拉完了) {
    @apply bg-gray-700;
  }
  :global(.rating-NPC) {
    @apply bg-sky-500;
  }
  :global(.rating-人上人) {
    @apply bg-violet-500;
  }
  :global(.rating-顶级) {
    @apply bg-amber-500;
  }
  :global(.rating-夯) {
    @apply bg-rose-500;
  }
</style>
