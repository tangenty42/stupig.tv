<template>
  <MyHeightSection tag="section" class="section-card-collapse">
    <div v-if="! props.invalid" class="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-start gap-x-3 gap-y-3">
      <MyContentRating :rating="labels" class="!px-6 !text-xl" />
      <h1 class="min-w-0 break-words">
        {{ title }}
      </h1>

      <div v-if="visible_labels.length || date" class="col-start-2 flex flex-wrap items-center gap-x-1.5 gap-y-1">
        <MyBadge v-for="label in visible_labels" :key="label" outlined type="info">
          {{ label }}
        </MyBadge>
        <span v-if="date" class="ml-auto pl-2 text-xs text-slate-400 dark:text-slate-500">{{ date }}</span>
      </div>

      <p v-if="desc" class="col-start-2 break-words text-sm text-slate-500 dark:text-slate-400">
        {{ desc }}
      </p>

      <button
        v-if="cover"
        type="button"
        class="col-start-2 w-fit cursor-zoom-in transition-[filter] duration-300 hover:brightness-90"
        :aria-label="`预览图片：${cover_alt_text}`"
        @click="preview_visible = true"
      >
        <img :src="cover_src" :alt="cover_alt_text" loading="lazy" class="max-h-60 w-auto rounded-sm">
      </button>
    </div>

    <ClientOnly>
      <MyImagePreview
        v-if="cover"
        v-model:visible="preview_visible"
        :images="preview_images"
        :initial-index="0"
      />
    </ClientOnly>
  </MyHeightSection>
</template>

<script setup lang="ts">
import { cover_alt, story_front_cover_url } from '~/utils/content/attachment'

const props = withDefaults(defineProps<{
  invalid?: boolean
  title: string
  labels: string[]
  desc?: string | null
  cover?: string | null
  /** Cover alt text (`![label](file.jpg)`); falls back to the file name. */
  coverLabel?: string | null
  /** Pre-formatted event date text shown at the right of the labels row. */
  date?: string | null
  /** Story owning the cover attachment; null for a new story (orphan uploads). */
  storyId?: number | null
}>(), {
  invalid: false,
  desc: null,
  cover: null,
  coverLabel: null,
  date: null,
  storyId: null,
})

const visible_labels = computed(() => props.labels.filter(label => ! label.startsWith('#')))
const cover_src = computed(() => (props.cover ? story_front_cover_url(props.cover, props.storyId) : undefined))

// The markdown label (`![label](file.jpg)`) is the preferred alt text; without
// one, fall back to the cover file name.
const cover_alt_text = computed(() => cover_alt(props.cover, props.coverLabel, props.title))

const preview_visible = ref(false)
const preview_images = computed(() => (cover_src.value ? [cover_src.value] : []))
</script>
