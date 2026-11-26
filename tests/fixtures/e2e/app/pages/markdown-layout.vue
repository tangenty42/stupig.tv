<template>
  <section v-if="loading_fixture" class="p-4">
    <MyContentStoryCard :story="loading_story" />
    <MyContentStoryHeader title="Loading cover" :labels="[]" cover="/api/e2e-css-image?name=plain-cover" />
    <button type="button" @click="large_preview = true">
      打开测试大图
    </button>
    <ClientOnly>
      <MyImagePreview v-model:visible="large_preview" :images="[large_preview_source]" />
    </ClientOnly>
    <div class="h-[4000px]" aria-hidden="true" />
    <MyContentMarkdownPreview markdown="![Lazy body](att://lazy.png)" :attachments="lazy_attachments" can-read-private />
  </section>
  <section v-else class="p-4">
    <button data-testid="layout-theme" @click="color_mode.preference = color_mode.value === 'dark' ? 'light' : 'dark'">
      切换主题
    </button>
    <button data-testid="layout-remount" @click="remount">
      重新挂载
    </button>
    <div data-testid="layout-preview" :style="{ width: narrow ? '288px' : '640px', maxWidth: '100%' }">
      <MyContentMarkdownPreview v-if="visible" :markdown="spacing_fixture ? spacing_markdown : markdown" :attachments="attachments" :stories="stories" :folders="['empty']" can-read-private folder-openable />
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
const wide_file = 'Week_11-1_Sample_Response_Essay_Media_Fear_Mongering__2___1__1.__docx'
const image = { revision: 1, width: 800, height: 320, lqip: null, has_original: false }
const attachments: ContentStoryAttachment[] = [
  { file_name: 'public.png', mime_type: 'image/png', file_size: 100, version: 'v1', is_image: true, url: '/api/e2e-css-image?name=public', image },
  { file_name: 'private.png', mime_type: 'image/png', file_size: 100, version: 'v1', is_image: true, is_private: true, url: '/api/e2e-css-image?name=private', image },
  { file_name: 'denied.png', mime_type: 'image/png', file_size: 100, version: 'v1', is_image: true, is_private: true, url: null },
  { file_name: 'redacted.png', mime_type: 'image/png', file_size: 100, version: 'v1', is_image: true, is_private: true, url: null, redacted_url: '/api/e2e-css-image?name=redacted', redacted_image: image },
  { file_name: 'restricted.txt.good', mime_type: 'text/plain', file_size: 100, version: 'v1', is_image: false, is_private: true, url: '/api/links/attachments/9001?version=fixture', has_redacted: true, redacted_url: '/api/links/attachments/9002?version=fixture' },
  { file_name: 'restricted.txt', mime_type: 'text/plain', file_size: 50, version: 'v1', is_image: false, is_redaction: true, url: '/api/links/attachments/9002?version=fixture' },
  { file_name: 'private-note.txt.good', mime_type: 'text/plain', file_size: 50, version: 'v1', is_private: true, url: null },
  { file_name: wide_file, mime_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', file_size: 23552, version: 'v1', is_image: false, url: '/api/e2e-file-wide' },
  ... ['one', 'two', 'three', 'four', 'five', 'six'].map(name => ({ file_name: `${name}.txt`, mime_type: 'text/plain', file_size: 1024, version: 'v1', is_image: false, url: `/api/e2e-file-${name}` })),
]
const stories: ContentStorySummary[] = [{ id: 999, title: 'Known', labels: [], desc: 'Story card', cover: null, cover_label: null, cover_version: null, cover_url: null, event_dates: [], event_precision: 'day', created_at: '', updated_at: '' }]
const loading_fixture = useRoute().query.loading === '1'
const spacing_fixture = useRoute().query.spacing === '1'
const large_preview = ref(false)
const large_preview_source = useRoute().query.preview === 'fade'
  ? '/api/e2e-css-image?name=fade-large'
  : '/api/e2e-css-image?name=broken-large'
const lqip = 'data:image/jpeg;base64,/9j/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAACAAQDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAABQf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCEAHUh/9k='
const loading_story = { ... stories[0]!, title: 'Loading list cover', cover: '/api/e2e-css-image?name=lqip-cover', cover_image: { ... image, lqip } }
const lazy_attachments = [{ ... attachments[0]!, file_name: 'lazy.png', url: '/api/e2e-css-image?name=lazy-body', is_private: true }]
const spacing_markdown = `
[\`测试\`](att://one.txt)
[](att://${wide_file})

[${'长链接在正文内应当随着内容折行'.repeat(16)}](att://two.txt)

Unwrapped media ![](att://public.png) [](att://one.txt)

![](att://denied.png) ![](att://denied.png) ![](att://denied.png)

<carousel>
[第一项](att://one.txt)[](att://two.txt)
[](att://three.txt)
</carousel>

<carousel>
[](att://one.txt)
111
222
333

## 轮播里的标题

- 列表甲
- 列表乙

> 轮播里的引用

| 名称 | 数量 |
| --- | --- |
| 表格甲 | 1 |

\`\`\`txt
轮播里的代码
\`\`\`

<carousel>
内层轮播 [](att://four.txt) [](att://five.txt) [](att://six.txt)
</carousel>
</carousel>

起始 <carousel id="inline-carousel-fixture" class="author-carousel" title="A > B" style="width: 180px">[](att://four.txt) [](att://five.txt) [](att://six.txt)</carousel> 结尾
`
const markdown = `# Markdown layout

Before **normal prose**.

<carousel>
![Public **caption**](att://public.png) [](att://restricted.txt.good) [](att://restricted.txt) [](att://empty) [](content://Known) ![Private caption](att://private.png) ![Denied caption](att://denied.png) ![Redacted caption](att://redacted.png) ![Player caption](iframe://player.bilibili.com/player.html?bvid=fixture)
</carousel>

after *normal prose*.

[Private ordinary link](att://restricted.txt.good) [Redacted ordinary link](att://restricted.txt) [Public ordinary link](att://one.txt)

Inline prose ![Inline caption](att://public.png) stays outside the strip and wraps normally across the available width.

<carousel>
[](att://one.txt) [](att://two.txt) [](att://private-note.txt.good) [](att://three.txt)
</carousel>

<carousel>
[](att://four.txt) [](att://five.txt) [](att://six.txt)
</carousel>
`

async function remount() {
  visible.value = false
  await nextTick()
  visible.value = true
}
</script>
