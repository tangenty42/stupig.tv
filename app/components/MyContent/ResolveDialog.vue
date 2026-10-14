<template>
  <MyDialog
    :visible="visible"
    :header="header"
    :pending="pending"
    :closable="! pending"
    @update:visible="emit('update:visible', $event)"
  >
    <div class="space-y-3 text-sm text-slate-600 dark:text-slate-300">
      <p v-if="message">
        {{ message }}
      </p>
      <ul class="max-h-[min(60vh,28rem)] space-y-2 overflow-y-auto">
        <li
          v-for="(item, index) in items"
          :key="item.item_id ?? `${item.name}:${index}`"
          class="border-b border-slate-200 pb-2 last:border-b-0 dark:border-slate-700"
        >
          <div class="flex min-w-0 items-start justify-between gap-3">
            <div class="min-w-0 flex-1">
              <p class="truncate font-medium text-slate-800 dark:text-slate-100">
                {{ item.resolution ? `${item.resolution.from} → ${item.resolution.to}` : item.name }}
              </p>
              <p class="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                {{ item.reason ?? item.resolution?.reason }}
              </p>
              <p v-if="item.resolution" class="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                {{ resolution_label(item.resolution.kind) }}
              </p>
            </div>
            <SelectButton
              v-if="item.resolution && item.item_id !== undefined"
              :model-value="choices.get(item.item_id)"
              :options="choice_options"
              option-label="label"
              option-value="value"
              :allow-empty="false"
              size="small"
              :disabled="pending"
              @update:model-value="set_choice(item.item_id, $event)"
            />
          </div>
        </li>
      </ul>
    </div>

    <template #footer>
      <div class="flex justify-end gap-2">
        <Button
          v-if="has_resolutions"
          label="取消"
          severity="secondary"
          text
          :disabled="pending"
          @click="emit('update:visible', false)"
        />
        <Button
          :label="has_resolutions ? '应用' : 'OK'"
          :loading="pending"
          :disabled="pending"
          @click="on_submit"
        />
      </div>
    </template>
  </MyDialog>
</template>

<script setup lang="ts">
import type { ContentTaskResolutionKind } from '@shared/types/content'
import type { ContentTaskResolveDialogItem } from '~/utils/content/task-row'
import { task_resolution_choices } from '~/utils/content/task-row'

const props = withDefaults(defineProps<{
  visible: boolean
  message?: string
  items: ContentTaskResolveDialogItem[]
  pending?: boolean
}>(), {
  message: '',
  pending: false,
})

const emit = defineEmits<{
  'update:visible': [visible: boolean]
  'resolve': [resolutions: { item_id: number, choice: 'apply' | 'skip' }[]]
}>()

const choice_options = [
  { label: '按内置行为', value: 'apply' as const },
  { label: '跳过', value: 'skip' as const },
]
const choices = ref(new Map<number, 'apply' | 'skip'>())
const has_resolutions = computed(() => props.items.some(item => item.resolution && item.item_id !== undefined))
const header = computed(() => has_resolutions.value ? '处理名称冲突' : '部分项目已跳过')

watch(() => [props.visible, props.items] as const, ([visible, items]) => {
  if (! visible)
    return
  choices.value = new Map(task_resolution_choices(items).map(entry => [entry.item_id, entry.choice]))
}, { immediate: true })

function resolution_label(kind: ContentTaskResolutionKind) {
  switch (kind) {
    case 'sanitize':
      return '文件名将被和谐'
    case 'rename':
      return '名称冲突，将使用建议名称'
    case 'merge':
      return '目标文件夹已存在，将合并内容'
  }
}

function set_choice(item_id: number, choice: 'apply' | 'skip') {
  const next = new Map(choices.value)
  next.set(item_id, choice)
  choices.value = next
}

function on_submit() {
  if (! has_resolutions.value) {
    emit('update:visible', false)
    return
  }
  emit('resolve', task_resolution_choices(props.items, choices.value))
}
</script>
