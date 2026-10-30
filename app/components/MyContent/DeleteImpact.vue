<template>
  <MyDialog :visible="visible" header="空城计？" :pending="pending" :closable="! pending" @update:visible="$emit('update:visible', $event)">
    <p>{{ description }}</p>
    <p v-if="loading" class="mt-3">
      正在检查已保存正文的引用…
    </p>
    <div v-else-if="failure" class="mt-3" role="alert">
      <p>引用检查失败，请重试后再删除。</p>
      <Button label="重试" text @click="$emit('retry')" />
    </div>
    <template v-else-if="impact">
      <p v-if="! impact.sources.length && ! impact.cloud_draft_references && ! draft.length" class="mt-3">
        {{ draftChecked ? '未发现可见正文、云端草稿或当前未上传修改的引用。' : '未发现可见正文或云端草稿的引用。' }}
      </p>
      <p v-if="impact.sources.length" class="mt-3">
        有正文正在引用。
      </p>
      <p v-if="impact.cloud_draft_references" class="mt-3">
        有云端草稿正在引用。
      </p>
      <p v-if="draft.length" class="mt-3">
        有未上传修改正在引用。
      </p>
    </template>
    <template #footer>
      <Button label="取消" severity="secondary" text :disabled="pending" @click="$emit('update:visible', false)" />
      <Button label="仍然删除" severity="danger" :loading="pending" :disabled="disabled || loading || !! failure || ! impact" @click="$emit('confirm')">
        <template #icon>
          <MyIcon name="lucide:check" />
        </template>
      </Button>
    </template>
  </MyDialog>
</template>

<script setup lang="ts">
import type { ContentDeleteImpact, ContentDeleteReference } from '@shared/types/content-delete-impact'

withDefaults(defineProps<{ visible: boolean, description: string, impact: ContentDeleteImpact | null, draft?: ContentDeleteReference[], draftChecked?: boolean, loading?: boolean, failure?: boolean, pending?: boolean, disabled?: boolean }>(), {
  draft: () => [], draftChecked: false, loading: false, failure: false, pending: false, disabled: false,
})
defineEmits<{ 'update:visible': [value: boolean], 'retry': [], 'confirm': [] }>()
</script>
