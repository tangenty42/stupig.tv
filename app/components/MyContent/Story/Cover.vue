<template>
  <span
    :key="src"
    ref="root"
    :class="frame.class_name"
    :style="frame.style"
    :data-lqip="frame.lqip ? '' : undefined"
    :data-image-sized="frame.size ? '' : undefined"
    :aria-busy="src ? 'true' : undefined"
    :data-image-error="src ? undefined : ''"
  >
    <img
      v-if="src"
      class="built-in-img"
      :src="src"
      :alt="alt"
      :width="frame.size?.width"
      :height="frame.size?.height"
      loading="lazy"
      decoding="async"
      referrerpolicy="no-referrer"
    >
    <span v-if="frame.lqip" class="image-lqip" aria-hidden="true" />
    <span v-if="src" class="image-loading-mask" role="status">
      <MyIcon name="lucide:loader-circle" />
      <span class="sr-only">图片加载中</span>
    </span>
    <span class="image-unavailable" role="img" aria-label="图片加载失败">
      <MyIcon name="lucide:image-off" />
    </span>
  </span>
</template>

<script setup lang="ts">
import type { ContentStoryAttachment } from '@shared/types/content'
import { settings } from '@shared/settings'
import { image_frame_presentation } from '~/features/content/image-frame'
import { observe_image_placeholders } from '~/features/content/image-placeholders'

const props = defineProps<{ src?: string, alt: string, image?: ContentStoryAttachment['image'], constrained?: boolean }>()
const root = useTemplateRef<HTMLElement>('root')
const frame = computed(() => image_frame_presentation(
  props.src ? { url: props.src, image: props.image } : undefined,
  settings.app.content.image.lqipMaxBytes,
  props.constrained ? 'constrained-cover' : 'cover',
))
let cleanup: (() => void) | undefined
let mounted = false
function observe() {
  if (! mounted)
    return
  cleanup?.()
  cleanup = root.value ? observe_image_placeholders(root.value) : undefined
}
watch([root, () => frame.value.lqip], observe, { flush: 'post' })
onMounted(() => {
  mounted = true
  observe()
})
onBeforeUnmount(() => {
  mounted = false
  cleanup?.()
})
</script>
