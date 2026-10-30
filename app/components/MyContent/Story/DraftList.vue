<template>
  <div>
    <div v-if="loading && ! data" class="space-y-3">
      <Skeleton v-for="i in 3" :key="i" height="3.5rem" />
    </div>
    <div v-else-if="data?.items.length" class="grid grid-cols-1 items-start gap-4 sm:grid-cols-2">
      <MyContentStoryCard v-for="draft in data.items" :key="draft.id" :draft="draft" />
    </div>
    <div v-else class="py-8 text-center text-sm text-slate-500 dark:text-slate-400">
      {{ after ? '这一页没有草稿~' : '还没有草稿~' }}
    </div>
    <div v-if="data && (after || data.next)" class="mt-5 flex justify-center gap-2">
      <Button v-if="after" label="返回第一页" text size="small" @click="after = ''" />
      <Button v-if="data.next" label="下一页" text size="small" @click="after = data!.next!" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { settings } from '@shared/settings'

const { content } = useApi()
const { user } = useAuth()
const after = ref('')
const viewer = computed(() => JSON.stringify([user.value?.id, user.value?.is_admin, user.value?.permissions]))
const data = ref<Awaited<ReturnType<typeof content.list_drafts>> | null>(null)
const loading = ref(false)
void useSyncedData(computed(() => data.value?.channel ?? null), () => content.list_drafts(after.value), data, loading, {
  server: false, universal: false, fetch_without_resource: true, query_key: computed(() => `draft-list:${viewer.value}:${after.value}`), polling_interval: settings.app.content.draft.keepaliveIntervalMs,
})
watch([viewer, after], () => {
  data.value = null
}, { flush: 'sync' })
</script>
