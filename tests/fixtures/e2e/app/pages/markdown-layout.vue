<template>
  <section class="p-4">
    <button data-testid="layout-theme" @click="color_mode.preference = color_mode.value === 'dark' ? 'light' : 'dark'">
      切换主题
    </button>
    <button data-testid="layout-remount" @click="remount">
      重新挂载
    </button>
    <div data-testid="layout-preview" :style="{ width: narrow ? '288px' : '640px', maxWidth: '100%' }">
      <MyContentMarkdownPreview v-if="visible" :markdown="markdown" :attachments="attachments" :stories="stories" :folders="['empty']" />
    </div>
    <button data-testid="layout-narrow" @click="narrow = ! narrow">
      切换窄屏
    </button>
  </section>
</template>

<script setup lang="ts">
import type { ContentStoryAttachment, ContentStorySummary } from '@shared/types/content'

const color_mode = useColorMode()
const visible = ref(true)
const narrow = ref(false)
const image = { revision: 1, width: 800, height: 320, lqip: null, has_original: false }
const attachments: ContentStoryAttachment[] = [
  { file_name: 'public.png', mime_type: 'image/png', file_size: 100, version: 'v1', is_image: true, url: '/api/e2e-css-image?name=public', image },
  { file_name: 'private.png', mime_type: 'image/png', file_size: 100, version: 'v1', is_image: true, is_private: true, url: '/api/e2e-css-image?name=private', image },
  { file_name: 'denied.png', mime_type: 'image/png', file_size: 100, version: 'v1', is_image: true, is_private: true, url: null },
  { file_name: 'redacted.png', mime_type: 'image/png', file_size: 100, version: 'v1', is_image: true, is_private: true, url: null, redacted_url: '/api/e2e-css-image?name=redacted', redacted_image: image },
  ... ['one', 'two', 'three', 'four', 'five', 'six'].map(name => ({ file_name: `${name}.txt`, mime_type: 'text/plain', file_size: 1024, version: 'v1', is_image: false, url: `/api/e2e-file-${name}` })),
]
const stories: ContentStorySummary[] = [{ id: 999, title: 'Known', labels: [], desc: 'Story card', cover: null, cover_label: null, cover_version: null, cover_url: null, event_dates: [], event_precision: 'day', created_at: '', updated_at: '' }]
const markdown = `# Markdown layout

Before **normal prose** ![Public **caption**](att://public.png) [](att://one.txt) [](att://empty) [](content://Known) ![Private caption](att://private.png) ![Denied caption](att://denied.png) ![Redacted caption](att://redacted.png) ![Player caption](iframe://player.bilibili.com/player.html?bvid=fixture) after *normal prose*.

Inline prose ![Inline caption](att://public.png) stays outside the strip and wraps normally across the available width.

[](att://one.txt) [](att://two.txt) [](att://three.txt)

[](att://four.txt) [](att://five.txt) [](att://six.txt)
`

async function remount() {
  visible.value = false
  await nextTick()
  visible.value = true
}
</script>
