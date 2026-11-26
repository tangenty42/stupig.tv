<template>
  <img v-if="src" :key="`preload:${src}`" ref="image" :src="src" alt="" hidden @load="reveal($event.currentTarget as HTMLImageElement)">
  <span v-if="src && loaded_src === src" :key="src" aria-hidden="true" class="story-watermark-image" :style="{ backgroundImage: `url('${src}')` }" />
</template>

<script setup lang="ts">
import { story_rating_rank } from '@shared/types/content'
import { image_load_state } from '~/features/content/image-placeholders'
import { story_rating_image_url } from '~/features/content/story-presentation'

const props = defineProps<{ labels: string[] }>()
const static_url = useStaticUrl()
const src = computed(() => {
  const rank = story_rating_rank(props.labels)
  return rank ? story_rating_image_url(static_url, rank) : ''
})
const image = useTemplateRef<HTMLImageElement>('image')
const loaded_src = ref('')

function reveal(element: HTMLImageElement | null) {
  if (element && element === image.value && element.getAttribute('src') === src.value && image_load_state(element) === 'loaded')
    loaded_src.value = src.value
}

watch(src, () => {
  loaded_src.value = ''
}, { flush: 'sync' })
// A cached SVG can finish loading before hydration attaches the listener.
watch(image, reveal, { flush: 'post' })
</script>

<style scoped>
.story-watermark-image {
  @apply pointer-events-none absolute opacity-[0.035] dark:opacity-[0.07] dark:brightness-125;
  inset: -60%;
  background-repeat: repeat;
  background-size: 10rem auto;
  transform: rotate(-30deg);
  /* In light mode, keep pale badges such as 拉完了 and 人上人 legible. */
  filter: brightness(0.1);
  /* The layer box is 2.2× the block, so the block's edge sits at ~46% of
     it — the mask fades the tiles out right at the block's edges. */
  mask-image: radial-gradient(ellipse 46% 46% at 50% 50%, #000 20%, transparent 100%);
  animation: story-watermark-fade-in 500ms ease-out;
}

@keyframes story-watermark-fade-in {
  from { opacity: 0; }
}

@media (prefers-reduced-motion: reduce) {
  .story-watermark-image {
    animation: none;
  }
}
</style>
