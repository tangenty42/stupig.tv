<template>
  <div :aria-busy="loading">
    <div v-if="loading && ! data" class="grid grid-cols-1 gap-4 sm:grid-cols-2" role="status" aria-label="正在加载草稿">
      <Skeleton v-for="i in 3" :key="i" height="5.75rem" class="rounded-sm" />
    </div>
    <template v-else>
      <MyContentListLoadError v-if="! loading && (error || ! data)" class="py-8" @retry="refresh" />
      <div v-if="data?.items.length" class="grid grid-cols-1 items-start gap-4 sm:grid-cols-2">
        <MyContentStoryCard v-for="draft in data.items" :key="draft.id" :draft="draft" />
      </div>
      <div v-else-if="data && (! error || loading)" class="py-8 text-center text-sm text-slate-500 dark:text-slate-400">
        还没有草稿~
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { useContentDraftList } from '~/features/content/draft-list'

const draft_list = useContentDraftList()
const { data, loading, error, refresh } = draft_list
// Holds the published list during a client-side switch (see the boundary in pages/content/index.vue).
// Skipped while hydrating: drafts load in the browser only, so the page hydrates against the SSR skeleton.
if (! useNuxtApp().isHydrating)
  await draft_list.ready
</script>
