<template>
  <main class="mx-auto min-h-screen max-w-5xl px-4 py-8">
    <header class="space-y-4">
      <h1>列表状态测试</h1>
      <div class="flex flex-wrap items-center gap-2" role="group" aria-label="列表场景">
        <Button
          v-for="item in scenarios" :key="item.value" size="small" :label="item.label"
          :outlined="phase !== item.value" :aria-pressed="phase === item.value" @click="show_all(item.value)"
        />
      </div>
      <div class="flex flex-wrap items-center gap-2">
        <label for="retry-result" class="text-sm">重试后</label>
        <Select v-model="retry_result" input-id="retry-result" :options="retry_options" option-label="label" option-value="value" size="small" />
        <Button size="small" text :label="dark ? '浅色主题' : '深色主题'" @click="dark = ! dark" />
        <Button size="small" text :label="narrow ? '常规宽度' : '窄列'" @click="narrow = ! narrow" />
      </div>
    </header>

    <div class="mx-auto mt-8 space-y-8" :class="{ 'max-w-[340px]': narrow }">
      <section class="section-card-collapse space-y-4" aria-labelledby="published-title">
        <h2 id="published-title">
          已发布档案
        </h2>
        <MyContentStoryPublishedList
          v-model:sort-by-rating="sort_by_rating"
          :stories="published_data"
          :loading="published_phase === 'loading'"
          :active-labels="labels"
          @toggle-label="toggle_label"
          @clear-labels="labels.clear()"
          @retry="retry(show_published)"
        />
      </section>

      <section class="section-card-collapse space-y-4" aria-labelledby="draft-title">
        <h2 id="draft-title">
          未发布草稿
        </h2>
        <Suspense>
          <MyContentStoryDraftList />
        </Suspense>
      </section>

      <section class="section-card-collapse space-y-4" aria-labelledby="attachments-title">
        <h2 id="attachments-title">
          附件
        </h2>
        <MyContentAttachmentWorkspace :controller="attachment.controller" :dialogs="false" layout="stack" />
      </section>
    </div>
  </main>
</template>

<script setup lang="ts">
import type { ContentStorySummary } from '@shared/types/content'
import { create_attachment_scene } from './attachment-scene'
import { create_draft_scene, draft_scene_key } from './draft-scene'

type Phase = 'loading' | 'failure' | 'empty' | 'ready'

const scenarios: { value: Phase, label: string }[] = [
  { value: 'loading', label: '加载中' },
  { value: 'failure', label: '加载失败' },
  { value: 'empty', label: '空列表' },
  { value: 'ready', label: '有数据' },
]
const retry_options = [
  { value: 'ready', label: '载入示例数据' },
  { value: 'empty', label: '返回空列表' },
  { value: 'failure', label: '再次失败' },
] as const

const phase = ref<Phase>('failure')
const retry_result = ref<Phase>('ready')
const dark = ref(false)
const narrow = ref(false)
useHead({ title: '列表状态测试', htmlAttrs: { lang: 'zh-CN', class: computed(() => dark.value ? 'dark' : '') } })

const published_phase = ref<Phase>('failure')
const sample_stories: ContentStorySummary[] = [
  { id: 1, title: '周末散步', labels: ['#置顶', '随笔'], desc: '已发布档案示例' },
  { id: 2, title: '第一次读书会', labels: ['活动'], desc: null },
].map(story => ({
  ... story,
  event_precision: 'day',
  event_dates: ['2026-11-23'],
  created_at: '2026-11-23T00:00:00Z',
  updated_at: '2026-11-23T00:00:00Z',
  cover: null,
  cover_label: null,
  cover_url: null,
  cover_version: null,
}))
const published_data = computed(() => published_phase.value === 'ready' ? sample_stories : published_phase.value === 'empty' ? [] : null)
const labels = reactive(new Set<string>())
const sort_by_rating = ref(false)
function toggle_label(label: string) {
  if (! labels.delete(label))
    labels.add(label)
}

function show_published(value: Phase) {
  published_phase.value = value
}

const draft = create_draft_scene(() => retry(show_draft))
provide(draft_scene_key, draft)
function show_draft(value: Phase) {
  draft.loading.value = value === 'loading'
  draft.error.value = value === 'failure' ? new Error('草稿加载失败') : null
  draft.data.value = value === 'ready'
    ? { items: [{ id: 'example', story_id: null, title: '周末记录草稿', updated_at: '2026-11-23T00:00:00Z' }] }
    : value === 'empty' ? { items: [] } : null
}

const attachment = create_attachment_scene(() => retry(attachment.show))
let generation = 0
function show_all(value: Phase) {
  generation ++
  phase.value = value
  labels.clear()
  show_published(value)
  show_draft(value)
  attachment.show(value)
}

async function retry(show: (value: Phase) => void) {
  const current = generation
  const result = retry_result.value
  show('loading')
  await new Promise(resolve => setTimeout(resolve, 1100))
  if (generation === current)
    show(result)
}

show_all(phase.value)
</script>
