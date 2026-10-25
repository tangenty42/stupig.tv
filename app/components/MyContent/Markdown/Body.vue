<template>
  <!-- The immutable seed serves SSR/hydration only. Subsequent HTML updates
       belong to the DOM patcher, so Vue never replaces this whole subtree. -->
  <!-- eslint-disable-next-line vue/no-v-html -->
  <div ref="root" class="story-body" v-html="initial_html" />
</template>

<script setup lang="ts">
import { create_preview_dom_patch, preview_html_fragment } from '~/utils/content/preview-dom'
import { wrap_heading_sections } from '~/utils/content/sticky-headings'

const props = defineProps<{ html: string }>()
const initial_html = props.html
const root = useTemplateRef<HTMLElement>('root')
let patch: ReturnType<typeof create_preview_dom_patch> | null = null
useStoryPreviewBody(root, () => props.html, (body, html) => {
  if (! patch) {
    wrap_heading_sections(body)
    patch = create_preview_dom_patch(body)
    if (html === initial_html)
      return
  }
  const fragment = preview_html_fragment(html, body.ownerDocument)
  wrap_heading_sections(fragment)
  patch.update(fragment)
})
defineExpose({ el: root })
</script>
