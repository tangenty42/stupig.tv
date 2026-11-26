<template>
  <!-- The immutable seed serves SSR/hydration only. Subsequent HTML updates
       belong to the DOM patcher. Render the seed without a dynamic innerHTML
       binding, which would replace the server's media nodes during hydration. -->
  <Seed v-bind="$attrs" />
</template>

<script setup lang="ts">
import type { FunctionalComponent } from 'vue'
import { h, mergeProps, shallowRef } from 'vue'
import { useStoryPreviewBody } from '~/features/content/markdown/preview-body'
import { create_preview_dom_patch, preview_html_fragment } from '~/features/content/markdown/preview/preview-dom'
import { wrap_heading_sections } from '~/features/content/markdown/preview/sticky-headings'

defineOptions({ inheritAttrs: false })
const props = defineProps<{ html: string }>()
const initial_html = props.html
const root = shallowRef<HTMLElement | null>(null)
const Seed: FunctionalComponent = (_props, { attrs }) => h('div', mergeProps(attrs, { ref: root, class: 'story-body', innerHTML: initial_html }))
Seed.inheritAttrs = false
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
