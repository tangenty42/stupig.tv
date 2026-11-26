<template>
  <MyDialog :visible="visible" header="空城计？" panel_class="max-w-lg" :pending="pending" :closable="! pending" @update:visible="$emit('update:visible', $event)">
    <template #header>
      <span class="text-xl font-semibold">空城计？</span>
    </template>

    <p class="text-sm">
      尚未删除，请核对受影响的引用：
    </p>

    <template v-if="impact">
      <div v-if="! impact.sources.length && ! impact.cloud_draft_references && ! draft.length" class="mt-5 rounded-lg border border-slate-200 bg-slate-50 p-4 dark:border-white/10 dark:bg-white/[0.025]">
        <p class="text-sm font-medium">
          <MyIcon name="lucide:circle-check" class="mr-2 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
          未发现引用
        </p>
        <p class="mt-1 text-xs leading-5 text-slate-500 dark:text-slate-400">
          {{ draftChecked ? '未发现可见正文、云端草稿或当前未保存的修改中的引用' : '未发现可见正文或云端草稿的引用' }}
        </p>
      </div>
      <div v-else class="mt-4 space-y-4">
        <section v-if="impact.sources.length" class="space-y-2" aria-label="正文引用">
          <div class="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <h3 class="text-sm font-medium">
              正文引用
            </h3>
            <span v-if="attachment_scope" class="ml-auto text-right text-xs text-slate-500 dark:text-slate-400">
              {{ reference_places(impact.sources.flatMap(source => source.references)) }}
            </span>
          </div>
          <ul v-if="! attachment_scope" class="space-y-1.5 pl-4">
            <li v-for="source in impact.sources" :key="source.story_id" class="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
              <NuxtLink :to="`/content/${source.story_id}`" target="_blank" rel="noopener" class="link min-w-0 max-w-full text-sm text-slate-700 dark:text-slate-300">
                <span class="min-w-0 break-words">
                  <MyIcon name="lucide:book-open" class="mr-1" />
                  {{ source.title }}
                </span>
              </NuxtLink>
              <span class="ml-auto text-right text-xs text-slate-500 dark:text-slate-400">{{ reference_places(source.references) }}</span>
            </li>
          </ul>
        </section>
        <section v-if="impact.cloud_draft_references || draft.length" class="space-y-2" aria-label="草稿引用">
          <div class="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <h3 class="text-sm font-medium">
              草稿引用
            </h3>
            <span v-if="impact.cloud_draft_references" class="ml-auto text-right text-xs text-slate-500 dark:text-slate-400">有引用</span>
          </div>
          <div v-if="draft.length" class="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 text-xs text-slate-500 dark:text-slate-400">
            <span>当前未保存的修改</span>
            <span class="ml-auto text-right">{{ reference_places(draft) }}</span>
          </div>
        </section>
      </div>
      <p class="mt-3 text-right text-xs leading-5 text-slate-400 dark:text-slate-500">
        <MyIcon name="lucide:clock-3" class="mr-1.5" aria-hidden="true" />
        <span>以上为打开此框时的检查结果</span>
      </p>
    </template>
    <template #footer>
      <div class="flex w-full items-center justify-end gap-2 pt-4 dark:border-white/10">
        <Button label="取消" severity="secondary" text :disabled="pending" @click="$emit('update:visible', false)" />
        <Button label="仍然删除" severity="danger" :loading="pending" :disabled="disabled || ! impact" @click="$emit('confirm')">
          <template #icon>
            <MyIcon name="lucide:check" />
          </template>
        </Button>
      </div>
    </template>
  </MyDialog>
</template>

<script setup lang="ts">
import type { ContentDeleteImpact, ContentDeleteReference } from '@shared/types/content-delete-impact'

const props = withDefaults(defineProps<{ visible: boolean, impact: ContentDeleteImpact | null, draft?: ContentDeleteReference[], draftChecked?: boolean, pending?: boolean, disabled?: boolean }>(), {
  draft: () => [], draftChecked: false, pending: false, disabled: false,
})
defineEmits<{ 'update:visible': [value: boolean], 'confirm': [] }>()

// Attachment deletes only check their own story, so its title adds nothing.
const attachment_scope = computed(() => props.impact?.targets.some(target => target.kind !== 'story') ?? false)

/** Line 0 is the stored cover field. */
function reference_places(references: ContentDeleteReference[]) {
  const lines = [... new Set(references.map(reference => reference.line))].sort((a, b) => a - b)
  const body = lines.filter(line => line > 0)
  const first_line = body.length ? `第 ${body[0]} 行${body.length > 1 ? '等' : ''}` : ''
  return [first_line, lines.includes(0) ? '封面' : ''].filter(Boolean).join('、')
}
</script>
