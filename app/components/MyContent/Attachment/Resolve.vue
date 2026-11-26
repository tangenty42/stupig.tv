<template>
  <MyDialog :visible="!! resolution" header="处理冲突" :closable="! pending" @update:visible="close">
    <div v-if="resolution" class="space-y-4">
      <p class="text-sm">
        操作尚未执行，请处理以下冲突：
      </p>
      <section v-for="group in groups" :key="group.key" class="space-y-2">
        <div class="flex cursor-pointer flex-wrap items-center justify-between gap-3" @click="toggle_group(group.key)">
          <button type="button" class="flex min-w-0 flex-1 items-center gap-2 text-left font-medium" :aria-expanded="! collapsed_groups.has(group.key)">
            <MyIcon :name="collapsed_groups.has(group.key) ? 'lucide:chevron-right' : 'lucide:chevron-down'" class="shrink-0" />
            <span class="min-w-0 break-words">{{ group.title }}</span>
          </button>
          <Select v-if="group.category" v-model="policy[group.category]" size="small" :options="group.allowed" option-label="label" option-value="value" :aria-label="group.title" :disabled="pending" @click.stop />
        </div>
        <div v-show="! collapsed_groups.has(group.key)" role="tree" :aria-label="group.title">
          <MyContentAttachmentCard
            v-for="row in group.rows" :key="row.key" :row="row" :menu_items="[]" readonly :context_menu="false"
            :display-path="row.depth === 0"
            role="treeitem" :aria-level="row.depth + 1" :aria-expanded="row.data.kind === 'folder' ? ! row.data.collapsed : undefined"
            :style="{ paddingLeft: `${0.5 + row.depth * 1.25}rem` }" @click="toggle_folder(row)" @open="toggle_folder(row)"
          />
        </div>
      </section>
    </div>
    <template #footer>
      <Button label="取消" severity="secondary" text :disabled="pending" @click="close" />
      <Button v-if="resolution" label="提交" :loading="pending" :disabled="pending" @click="submit_resolution">
        <template #icon>
          <MyIcon name="lucide:check" />
        </template>
      </Button>
    </template>
  </MyDialog>
</template>

<script setup lang="ts">
import type { ErrorCategory, ErrorPolicy, WorkspaceIssue } from '@shared/content-workspace'
import type { ContentWorkspaceNode } from '@shared/types/content'
import type { MyContentAttachmentRow } from '~/features/content/attachments/list-model'
import { attachment_name_key, error_categories, error_policy_schema } from '@shared/content-workspace'
import { attachment_summary_tree } from '~/features/content/attachments/list-model'

const props = withDefaults(defineProps<{ resolution: { items: WorkspaceIssue[], valid_count: number } | null, pending: boolean, nodes?: ContentWorkspaceNode[] }>(), { nodes: () => [] })
const emit = defineEmits<{ submit: [policy: ErrorPolicy], close: [] }>()
const policy = reactive(error_policy_schema.parse({}))
const collapsed_folders = ref(new Set<string>())
const collapsed_groups = ref(new Set<string>())
watch(() => props.resolution, () => {
  Object.assign(policy, error_policy_schema.parse({}))
  collapsed_folders.value = new Set()
  collapsed_groups.value = new Set()
})
const labels: Record<ErrorCategory, string> = { name_conflict: '名称冲突', reserved: '名称被预约', source_busy: '源正在使用', invalid_name: '名称不可用', other: '其他问题', redacted: '已有删减版' }
const actions = { fail: '只重试', skip: '跳过', suffix: '自动编号', sanitize: '清洗', keep: '保留旧删减版', discard: '删除旧删减版' }
const groups = computed(() => error_categories.flatMap((category) => {
  const items = props.resolution?.items.filter(item => item.category === category) ?? []
  const single = (props.resolution?.valid_count ?? 0) + (props.resolution?.items.length ?? 0) === 1
  if (! items.length)
    return []
  const allowed = items[0]!.allowed.filter(action => (! single || action !== 'skip') && items.every(item => item.allowed.includes(action))).map(value => ({ value, label: category === 'redacted' && value === 'fail' ? '取消此次覆盖' : actions[value] }))
  // These categories contain distinct reasons; keep each explanation once in
  // its heading, while the category-wide policy still applies to all of them.
  const titles = category === 'other' || category === 'invalid_name' ? [... new Set(items.map(item => item.reason))] : [labels[category]]
  return titles.map((title) => {
    const members = items.filter(item => (category !== 'other' && category !== 'invalid_name') || item.reason === title)
    const paths = members.map(item => item.target)
    const target_kinds = new Map(members.flatMap(item => item.is_folder === undefined ? [] : [[attachment_name_key(item.target), item.is_folder] as const]))
    return {
      category, key: `${category}:${title}`, title, allowed,
      rows: attachment_summary_tree(paths, props.nodes, { prefer_private: category === 'redacted', conflicts: new Set(paths.map(attachment_name_key)), collapsed: collapsed_folders.value, target_kinds }),
    }
  })
}))
function toggle_group(key: string) {
  const next = new Set(collapsed_groups.value)
  if (next.has(key))
    next.delete(key)
  else
    next.add(key)
  collapsed_groups.value = next
}
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
const cancel_overwrite = computed(() => props.resolution?.items.some(item => item.category === 'redacted') && policy.redacted === 'fail')
function submit_resolution() {
  if (props.pending)
    return
  if (cancel_overwrite.value)
    close()
  else
    emit('submit', { ... policy })
}
function close() {
  if (! props.pending) {
    Object.assign(policy, error_policy_schema.parse({}))
    emit('close')
  }
}
</script>
