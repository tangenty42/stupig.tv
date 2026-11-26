<template>
  <MyHeightSection tag="section" class="story-header section-card-collapse">
    <div class="flex min-w-0 flex-col gap-3">
      <div v-if="back || (editable && storyId) || $slots.actions" class="mx-auto flex w-full max-w-5xl flex-wrap items-end gap-3 px-4">
        <Button v-if="back" class="aspect-square" outlined aria-label="返回" @click="router.back()">
          <template #icon>
            <MyIcon name="lucide:arrow-left" />
          </template>
        </Button>
        <div class="ml-auto flex flex-wrap justify-end gap-3">
          <!-- Page-specific actions (e.g. 删除/保存 on the edit page) replace the default 编辑 link. -->
          <slot name="actions">
            <Button
              v-if="editable && storyId"
              size="small"
              severity="secondary"
              text
              label="编辑"
              @click="navigateTo(`/content/${storyId}/edit`)"
            >
              <template #icon>
                <MyIcon name="lucide:pencil" />
              </template>
            </Button>
          </slot>
        </div>
      </div>

      <div
        v-if="! props.invalid"
        class="watermark story-header-band mt-2 bg-slate-100 py-8 dark:bg-slate-800/50"
      >
        <MyContentStoryWatermark :labels="labels" />
        <div class="mx-auto flex w-full max-w-5xl flex-col items-center gap-3 px-4">
          <h1 class="min-w-0 break-words">
            {{ title }}
          </h1>

          <p v-if="date" class="text-xs text-slate-400 dark:text-slate-500">
            {{ date }}
          </p>

          <button
            v-if="cover"
            type="button"
            class="story-cover-button mt-4 w-fit cursor-zoom-in hover:brightness-90 dark:hover:brightness-125"
            :aria-label="`预览：${cover_alt_text}`"
            @click="preview_visible = true"
          >
            <MyContentStoryCover :src="cover_src" :alt="cover_alt_text" :image="coverImage" constrained />
          </button>

          <p v-if="desc" class="min-w-0 break-words text-sm text-center text-slate-500 dark:text-slate-400">
            {{ desc }}
          </p>

          <div v-if="visible_labels.length || date" class="w-full flex flex-wrap justify-center items-center gap-x-1.5 gap-y-1">
            <MyBadge v-for="label in visible_labels" :key="label" outlined type="info">
              {{ label }}
            </MyBadge>
          </div>
        </div>
      </div>
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
import type { ContentStoryAttachment } from '@shared/types/content'
import { cover_alt, story_front_cover_url } from '~/features/content/story-cover'
import { visible_story_labels } from '~/features/content/story-presentation'

const props = withDefaults(defineProps<{
  invalid?: boolean
  title: string
  labels: string[]
  desc?: string | null
  cover?: string | null
  /** Cover alt text (`![label](file.jpg)`); falls back to the file name. */
  coverLabel?: string | null
  /** Root-relative object URL of a local-attachment cover, from the server payload. */
  coverUrl?: string | null
  coverImage?: ContentStoryAttachment['image']
  /** Pre-formatted event date text shown at the right of the labels row. */
  date?: string | null
  /** Story owning the cover attachment; null for a new story. */
  storyId?: number | null
  /** Show the back button above the header band. */
  back?: boolean
  /** Show the edit link (to `/content/{storyId}/edit`) above the header band. */
  editable?: boolean
}>(), {
  invalid: false,
  desc: null,
  cover: null,
  coverLabel: null,
  coverUrl: null,
  date: null,
  storyId: null,
  back: false,
  editable: false,
})

const router = useRouter()

const visible_labels = computed(() => visible_story_labels(props.labels))
const static_url = useStaticUrl()
const cover_src = computed(() => (props.cover ? story_front_cover_url(static_url, props.cover, props.coverUrl) : undefined))

// The markdown label (`![label](file.jpg)`) is the preferred alt text; without
// one, fall back to the cover file name.
const cover_alt_text = computed(() => cover_alt(props.cover, props.coverLabel, props.title))

const preview_visible = ref(false)
const preview_images = computed(() => (cover_src.value ? [cover_src.value] : []))
</script>

<style scoped>
/* The height transition clips its children while a late cover resizes.
   Give that clip the same width as the painted rating band. */
.story-header {
  margin-inline: calc(50% - var(--app-half-viewport, 50vw));
}

html .story-cover-button {
  max-width: 100%;
  transition: filter 300ms ease;
}

@media (prefers-reduced-motion: reduce) {
  html .story-cover-button {
    transition: none;
  }
}
</style>
