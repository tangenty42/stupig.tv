<template>
  <span class="hidden" aria-hidden="true">
    <MyIcon name="lucide:loader-circle" />
    <MyIcon name="lucide:image-off" />
  </span>
  <!-- All attributes and bounded inline JPEG data are escaped by the shared renderer. -->
  <!-- eslint-disable-next-line vue/no-v-html -->
  <span ref="root" class="contents" v-html="html" />
</template>

<script setup lang="ts">
import type { ContentStoryAttachment } from '@shared/types/content'
import { observe_image_placeholders } from '~/utils/content/lqip'
import { render_story_cover } from '~/utils/content/story-cover'

const props = defineProps<{ src?: string, alt: string, image?: ContentStoryAttachment['image'], constrained?: boolean }>()
const root = useTemplateRef<HTMLElement>('root')
const html = computed(() => render_story_cover(props.src, props.alt, props.image, props.constrained))
let cleanup: (() => void) | undefined
let mounted = false
function observe() {
  if (! mounted)
    return
  cleanup?.()
  cleanup = root.value ? observe_image_placeholders(root.value) : undefined
}
watch(html, observe, { flush: 'post' })
onMounted(() => {
  mounted = true
  observe()
})
onBeforeUnmount(() => {
  mounted = false
  cleanup?.()
})
</script>
