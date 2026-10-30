<template>
  <section class="p-4">
    <p data-testid="media-ready">
      {{ mounted ? 'client' : 'server' }}
    </p>
    <button data-testid="media-narrow" @click="narrow = ! narrow">
      切换窄屏
    </button>
    <button data-testid="media-theme" @click="color_mode.preference = color_mode.value === 'dark' ? 'light' : 'dark'">
      切换主题
    </button>
    <button data-testid="media-edit" @click="revision ++">
      修改正文
    </button>
    <button data-testid="media-remount" @click="remount">
      重新挂载
    </button>
    <button data-testid="media-load" @click="loading = true">
      加载私有图片
    </button>
    <button data-testid="media-public" @click="public_view = ! public_view">
      切换公开视图
    </button>
    <div data-testid="media-preview" :style="{ width: narrow ? '288px' : '640px', maxWidth: '100%' }">
      <MyContentMarkdownPreview v-if="visible" :markdown="markdown" :attachments="attachments" :public-view="public_view" />
    </div>
  </section>
</template>

<script setup lang="ts">
import type { ContentStoryAttachment } from '@shared/types/content'

const mounted = ref(false)
const visible = ref(true)
const narrow = ref(false)
const loading = ref(false)
const public_view = ref(false)
const revision = ref(0)
const color_mode = useColorMode()
const attachments: ContentStoryAttachment[] = ['one', 'two', 'three', 'loading', 'failed'].map(name => ({
  file_name: `${name}.png`, mime_type: 'image/png', file_size: 100,
  version: 'v1', is_image: true, is_private: true, is_encrypted: false,
  url: `/api/e2e-css-image?name=${name}`,
  image: { revision: 1, width: 800, height: 320, lqip: 'data:image/jpeg;base64,/9j/2wBDABQODxIPDRQSEBIXFRQYHjIhHhwcHj0sLiQySUBMS0dARkVQWnNiUFVtVkVGZIhlbXd7gYKBTmCNl4x9lnN+gXz/2wBDARUXFx4aHjshITt8U0ZTfHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHz/wAARCAACAAIDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAL/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAABf/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/ALABln//2Q==', has_original: false },
}))
const markdown = computed(() => `# Media compatibility

![First](att://one.png)
![Second](att://two.png)
![Third](att://three.png)

Revision ${revision.value}
${loading.value ? '\n![Loading](att://loading.png)\n\n![Failed](att://failed.png)' : ''}`)

onMounted(() => mounted.value = true)
async function remount() {
  visible.value = false
  await nextTick()
  visible.value = true
}
</script>
