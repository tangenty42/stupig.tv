<template>
  <MyDialog :visible="!! resolution || !! report" :header="resolution ? '处理冲突' : '操作回执'" :closable="! pending" @update:visible="close">
    <div v-if="resolution" class="space-y-4">
      <p class="text-sm">
        整批尚未执行，{{ resolution.items.length }} 项需要处理：
      </p>
      <section v-for="group in display_groups" :key="group.key" class="space-y-2">
        <div class="flex cursor-pointer flex-wrap items-center justify-between gap-3" @click="toggle_group(group.key)">
          <button type="button" class="flex min-w-0 flex-1 items-center gap-2 text-left font-medium" :aria-expanded="expanded_groups.has(group.key)">
            <MyIcon :name="expanded_groups.has(group.key) ? 'lucide:chevron-down' : 'lucide:chevron-right'" class="shrink-0" />
            <span class="min-w-0 break-words">{{ group.title }}</span>
          </button>
          <Select v-if="group.category" v-model="policy[group.category]" :options="group.allowed" option-label="label" option-value="value" :aria-label="group.title" :disabled="pending" @click.stop />
        </div>
        <div v-show="expanded_groups.has(group.key)" role="tree" :aria-label="group.title">
          <MyContentAttachmentCard
            v-for="row in group.rows" :key="row.key" :row="row" :menu_items="[]" readonly :context_menu="false"
            :display-path="row.depth === 0"
            role="treeitem" :aria-level="row.depth + 1" :aria-expanded="row.data.kind === 'folder' ? ! row.data.collapsed : undefined"
            :style="{ paddingLeft: `${0.5 + row.depth * 1.25}rem` }" @click="toggle_folder(row)" @open="toggle_folder(row)"
          />
        </div>
      </section>
    </div>
    <div v-else-if="report" class="space-y-2 text-sm">
      <p>{{ admission ? '已受理' : '成功' }} {{ report.succeeded.length }} 项，跳过 {{ report.skipped.length }} 项。</p>
      <p v-if="admission">
        文件上传和发布进度请查看附件列表。
      </p>
      <p v-for="item in report.renamed" :key="`${item.target}:${item.via}`" class="break-words">
        {{ item.from }} → {{ item.to }}（{{ item.via === 'suffix' ? '自动编号' : '清洗' }}）
      </p>
      <p v-for="item in report.skipped" :key="item.target" class="break-words">
        {{ item.target }}：{{ item.reason }}
      </p>
    </div>
    <template #footer>
      <Button label="取消" severity="secondary" text :disabled="pending" @click="close" />
      <Button v-if="resolution" label="重试" :loading="pending" :disabled="pending" @click="submit_resolution">
        <template #icon>
          <MyIcon name="lucide:rotate-cw" />
        </template>
      </Button>
    </template>
  </MyDialog>
</template>

<script setup lang="ts">
import type { ErrorCategory, ErrorPolicy, WorkspaceIssue, WorkspaceReport } from '@shared/content-workspace'
import type { ContentWorkspaceNode } from '@shared/types/content'
import type { MyContentAttachmentRow } from '~/utils/content/attachment-list'
import { attachment_name_key, error_categories, error_policy_schema } from '@shared/content-workspace'
import { attachment_summary_tree } from '~/utils/content/attachment-list'

const props = withDefaults(defineProps<{ resolution: { items: WorkspaceIssue[], valid_count: number, valid_targets?: string[] } | null, report: WorkspaceReport | null, pending: boolean, admission?: boolean, nodes?: ContentWorkspaceNode[] }>(), { nodes: () => [] })
const emit = defineEmits<{ submit: [policy: ErrorPolicy], close: [] }>()
const policy = reactive(error_policy_schema.parse({}))
const collapsed_folders = ref(new Set<string>())
const expanded_groups = ref(new Set<string>())
watch(() => props.resolution, () => {
  Object.assign(policy, error_policy_schema.parse({}))
  collapsed_folders.value = new Set()
  expanded_groups.value = new Set()
})
const conflicts = computed(() => new Set(props.resolution?.items.map(item => attachment_name_key(item.target))))
const labels: Record<ErrorCategory, string> = { name_conflict: '名称冲突', reserved: '名称被预约', source_busy: '源正在使用', invalid_name: '名称不可用', other: '其他问题', redacted: '已有删减版' }
const actions = { fail: '报错', skip: '跳过', suffix: '自动编号', sanitize: '清洗', keep: '保留旧删减版', discard: '删除旧删减版' }
const groups = computed(() => error_categories.flatMap((category) => {
  const items = props.resolution?.items.filter(item => item.category === category) ?? []
  const single = (props.resolution?.valid_count ?? 0) + (props.resolution?.items.length ?? 0) === 1
  if (! items.length)
    return []
  const allowed = items[0]!.allowed.filter(action => (! single || action !== 'skip') && items.every(item => item.allowed.includes(action))).map(value => ({ value, label: category === 'redacted' && value === 'fail' ? '取消此次覆盖' : actions[value] }))
  // These categories contain distinct reasons; keep each explanation once in
  // its heading, while the category-wide policy still applies to all of them.
  const titles = category === 'other' || category === 'invalid_name' ? [... new Set(items.map(item => item.reason))] : [labels[category]]
  return titles.map(title => ({
    category, key: `${category}:${title}`, title,
    allowed,
    rows: attachment_summary_tree(items.filter(item => (category !== 'other' && category !== 'invalid_name') || item.reason === title).map(item => item.target), props.nodes, { prefer_private: category === 'redacted', conflicts: conflicts.value, collapsed: collapsed_folders.value }),
  }))
}))
const valid_rows = computed(() => attachment_summary_tree(props.resolution?.valid_targets ?? [], props.nodes, { conflicts: conflicts.value, collapsed: collapsed_folders.value }))
const display_groups = computed(() => [
  ... groups.value,
  ... (props.resolution?.valid_count ? [{ key: 'valid', category: null, title: `其余 ${props.resolution.valid_count} 项无错误`, allowed: [], rows: valid_rows.value }] : []),
])
function toggle_group(key: string) {
  const next = new Set(expanded_groups.value)
  if (next.has(key))
    next.delete(key)
  else
    next.add(key)
  expanded_groups.value = next
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
