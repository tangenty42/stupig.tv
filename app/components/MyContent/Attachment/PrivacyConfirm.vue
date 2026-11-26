<template>
  <MyDialog :visible="!! confirmation" header="附件状态变更确认" :closable="! pending" @update:visible="close">
    <div v-if="confirmation" class="space-y-3">
      <p class="text-sm">
        操作尚未执行，请确认以下状态变化：
      </p>
      <div class="max-h-[50vh] overflow-y-auto" role="tree" aria-label="附件状态变更" tabindex="0">
        <div
          v-for="row in rows" :key="row.key" class="flex items-center gap-2"
          role="treeitem" :aria-level="row.depth + 1" :aria-expanded="row.data.kind === 'folder' ? ! row.data.collapsed : undefined"
          :aria-description="change_of(row) ? describe(change_of(row)!) : undefined"
        >
          <MyContentAttachmentCard
            class="min-w-0 flex-1" :row="row" :menu_items="[]" readonly :context_menu="false" :display-path="row.depth === 0"
            :style="{ paddingLeft: `${0.5 + row.depth * 1.25}rem` }" @click="toggle_folder(row)" @open="toggle_folder(row)"
          />
          <span v-if="change_of(row)" class="flex shrink-0 items-center gap-1 pr-2 text-xs" :title="describe(change_of(row)!)">
            <MyIcon v-bind="marker(change_of(row)!, change_of(row)!.from)" aria-hidden="true" />
            <MyIcon name="lucide:arrow-right" class="text-slate-400 dark:text-slate-500" aria-hidden="true" />
            <MyIcon v-bind="marker(change_of(row)!, change_of(row)!.to)" aria-hidden="true" />
          </span>
        </div>
      </div>
      <p class="text-right text-xs leading-5 text-slate-400 dark:text-slate-500">
        <MyIcon name="lucide:clock-3" class="mr-1.5" aria-hidden="true" />
        <span>以上为打开此框时的检查结果</span>
      </p>
    </div>
    <template #footer>
      <Button label="取消" severity="secondary" text :disabled="pending" @click="close" />
      <Button v-if="confirmation" label="继续" :loading="pending" :disabled="pending" @click="! pending && emit('confirm')">
        <template #icon>
          <MyIcon name="lucide:check" />
        </template>
      </Button>
    </template>
  </MyDialog>
</template>

<script setup lang="ts">
import type { PrivacyChange, PrivacyConfirmation } from '@shared/content-workspace'
import type { MyContentAttachmentRow } from '~/features/content/attachments/list-model'
import { attachment_name_key } from '@shared/content-workspace'
import { attachment_summary_tree } from '~/features/content/attachments/list-model'
import { file_icon } from '~/features/content/attachments/rules'

const props = defineProps<{ confirmation: PrivacyConfirmation | null, pending: boolean }>()
const emit = defineEmits<{ confirm: [], close: [] }>()
const collapsed_folders = ref(new Set<string>())
watch(() => props.confirmation, () => {
  collapsed_folders.value = new Set()
})
const changes = computed(() => new Map((props.confirmation?.changes ?? []).map(change => [attachment_name_key(change.path), change])))
const change_of = (row: MyContentAttachmentRow) => changes.value.get(attachment_name_key(row.source.path))
// Rows show the resulting paths, so stored rows (with their old state) are not looked up.
const rows = computed(() => {
  const entries = props.confirmation?.changes ?? []
  const target_kinds = new Map(entries.map(change => [attachment_name_key(change.path), change.is_folder]))
  return attachment_summary_tree(entries.map(change => change.path), [], { collapsed: collapsed_folders.value, target_kinds }).map((row) => {
    const change = change_of(row)
    if (! change || row.data.kind === 'folder')
      return row
    // A 删减版 inside a private folder is public.
    return { ... row, data: { ... row.data, is_private: change.to.private, is_redaction: change.to.redaction } }
  })
})
type PrivacyState = PrivacyChange['from']
function marker(change: PrivacyChange, state: PrivacyState) {
  const name = change.is_folder ? 'lucide:folder' : file_icon({ file_name: change.path, mime_type: null })
  const color = state.private
    ? 'content-accent-private'
    : state.redaction ? 'content-accent-redacted' : 'content-accent-neutral'
  return { name, class: color }
}
const state_label = (state: PrivacyState) => state.private ? '机密' : state.redaction ? '删减版' : '公开'
const describe = (change: PrivacyChange) => `${state_label(change.from)} → ${state_label(change.to)}`
function toggle_folder(row: MyContentAttachmentRow) {
  if (row.data.kind !== 'folder')
    return
  const key = attachment_name_key(row.data.path)
  const next = new Set(collapsed_folders.value)
  if (next.has(key))
    next.delete(key)
  else
    next.add(key)
  collapsed_folders.value = next
}
function close() {
  if (! props.pending)
    emit('close')
}
</script>
