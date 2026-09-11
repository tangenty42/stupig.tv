<template>
  <div class="relative flex flex-col gap-y-2 border-t border-slate-200 bg-slate-50 p-3 dark:border-slate-700 dark:bg-slate-800/50 overflow-hidden">
    <Button
      link
      aria-label="关闭查找替换"
      class="!absolute -right-2 -top-2"
      @click="search.close_search()"
    >
      <template #icon>
        <MyIcon name="lucide:x" class="text-xl" />
      </template>
    </Button>
    <div class="flex flex-wrap items-center gap-x-3 gap-y-2 pr-8">
      <InputText
        ref="search_input"
        v-model="query"
        size="small"
        placeholder="查找"
        aria-label="查找"
        class="min-w-[10rem] flex-1"
        @keydown="on_find_input_keydown"
        @keydown.esc.prevent="search.close_search()"
      />
      <span class="min-w-[3.5rem] text-right font-mono text-xs text-slate-400 dark:text-slate-500" aria-live="polite">
        {{ search.status_text }}
      </span>
      <div class="flex items-center gap-1">
        <Button size="small" severity="secondary" outlined label="上一个" :disabled="! search.match_count" @click="search.find_previous()" />
        <Button size="small" severity="secondary" outlined label="下一个" :disabled="! search.match_count" @click="search.find_next()" />
        <Button size="small" severity="secondary" outlined label="全部选中" :disabled="! search.match_count" @click="search.select_all_matches()" />
      </div>
      <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-600 dark:text-slate-300">
        <label class="flex items-center gap-1.5">
          <Checkbox v-model="match_case" binary size="small" />
          区分大小写
        </label>
        <label class="flex items-center gap-1.5">
          <Checkbox v-model="match_regexp" binary size="small" />
          正则
        </label>
        <label class="flex items-center gap-1.5">
          <Checkbox v-model="match_word" binary size="small" />
          全词匹配
        </label>
      </div>
    </div>
    <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
      <InputText
        v-model="replace"
        size="small"
        placeholder="替换为"
        aria-label="替换为"
        class="min-w-[10rem] flex-1"
        @keydown.enter.prevent="search.replace_current()"
        @keydown.esc.prevent="search.close_search()"
      />
      <div class="flex items-center gap-1">
        <Button size="small" severity="secondary" outlined label="替换" :disabled="! search.match_count" @click="search.replace_current()" />
        <Button size="small" severity="secondary" outlined label="全部替换" :disabled="! search.match_count" @click="search.replace_all()" />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { MarkdownSearch } from '~/composables/useMarkdownSearch'

const props = defineProps<{
  search: MarkdownSearch
}>()

// toRefs keeps v-model off the prop object; writes flow through the shared
// reactive search state created by the editor.
const { query, replace, match_case, match_regexp, match_word } = toRefs(props.search)

const search_input = ref<{ $el: HTMLInputElement } | null>(null)

function select_input() {
  search_input.value?.$el.select()
}

onMounted(() => void nextTick(select_input))

// Re-focus on every open_search() (Mod-f in the editor re-selects the input
// even while the panel is already open).
watch(() => props.search.activation, () => void nextTick(select_input))

function on_find_input_keydown(event: KeyboardEvent) {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
    event.preventDefault()
    select_input()
    return
  }
  if (event.key !== 'Enter')
    return
  event.preventDefault()
  if (event.shiftKey)
    props.search.find_previous()
  else
    props.search.find_next()
}
</script>
