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
      rounded-tr-[.2rem]
      rounded-bl-full
      rounded-br-[.2rem]
      ps-[2em]
      pe-[.8em]
      py-[.5em]
      text-xs
      font-bold
      text-white;
  }
  /* The rating-* palette lives in global.css. */
</style>
