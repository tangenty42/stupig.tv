<template>
  <div class="space-y-2">
    <div class="flex flex-wrap items-center justify-end gap-2">
      <div class="flex items-center gap-3">
        <SelectButton
          v-model="editor_mode"
          :options="editor_modes"
          option-label="label"
          option-value="value"
          :allow-empty="false"
          aria-label="编辑器模式"
          size="small"
        >
          <template #option="{ option }">
            <span class="flex items-center gap-1.5">
              <MyIcon :name="option.icon" />
              <span>{{ option.label }}</span>
            </span>
          </template>
        </SelectButton>
        <span
          class="text-xs"
          :class="issues.length ? 'text-red-500 dark:text-red-400' : 'text-emerald-600 dark:text-emerald-400'"
        >
          <MyIcon :name="issues.length ? 'lucide:circle-alert' : 'lucide:circle-check'" class="mr-1 align-text-bottom" />
          {{ issues.length ? `${issues.length} 个 lint 问题` : 'lint 通过' }}
        </span>
      </div>
    </div>

    <div
      v-show="editor_mode === 'edit'"
      class="overflow-hidden rounded-sm border border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900"
      :class="{ 'border-dashed border-brand-400 dark:border-brand-600': drag_over }"
      @dragover.prevent="on_drag_over"
      @dragleave.prevent="drag_over = false"
      @drop.prevent="on_drop"
    >
      <div
        v-if="! editor_ready"
        class="flex min-h-80 max-h-[60vh] items-center justify-center text-sm text-slate-400 dark:text-slate-500"
      >
        代码编辑器加载中...
      </div>
      <div
        ref="editor_host"
        :class="{ hidden: ! editor_ready }"
      />
    </div>

    <div
      v-show="editor_mode === 'preview'"
      class="min-h-80 overflow-hidden rounded-sm border border-slate-200 bg-white p-5 dark:border-slate-700 dark:bg-slate-900"
    >
      <MyContentMarkdownPreview :markdown="model" :story-id="storyId" :attachments="attachments" empty-text="暂无可预览内容" />
    </div>

    <div v-if="editor_mode === 'edit' && issues.length" class="rounded-sm border border-slate-200 bg-slate-50 p-2 dark:border-slate-700 dark:bg-slate-800/50">
      <button
        v-for="(issue, index) in issues"
        :key="index"
        type="button"
        class="flex w-full items-start gap-2 rounded px-2 py-1 text-left text-xs hover:bg-slate-100 dark:hover:bg-slate-700/50"
        @click="jump_to_line(issue.from)"
      >
        <span class="shrink-0 font-mono text-slate-400">第 {{ issue.line }} 行</span>
        <span class="text-slate-600 dark:text-slate-300">{{ issue.message }}</span>
        <span v-if="issue.source" class="ml-auto shrink-0 font-mono text-slate-400">{{ issue.source }}</span>
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { Diagnostic } from '@codemirror/lint'
import type { Text } from '@codemirror/state'
import type { ContentStoryAttachment } from '@shared/types/content'
import { markdown as markdown_lang } from '@codemirror/lang-markdown'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { linter, lintGutter } from '@codemirror/lint'
import { Compartment, EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { tags } from '@lezer/highlight'
import { parse_story_markdown } from '@shared/content-markdown'
import { basicSetup } from 'codemirror'
import { lint as markdownlint } from 'markdownlint/sync'
import { content_attachment_markdown, get_content_attachment_drag_data } from '~/utils/content/attachment-drag'

interface LintListItem {
  from: number
  line: number
  message: string
  source: string | null
}

withDefaults(defineProps<{
  storyId?: number | null
  attachments?: ContentStoryAttachment[]
  placeholder?: string
}>(), {
  storyId: null,
  attachments: () => [],
  placeholder: '',
})

const emit = defineEmits<{
  'lint': [issues: LintListItem[]]
  'files-dropped': [files: File[], position: number | null]
}>()

const model = defineModel<string>({ default: '' })

const color_mode = useMyColorMode()

const editor_host = ref<HTMLElement>()
const editor_ready = ref(false)
const drag_over = ref(false)
const issues = ref<LintListItem[]>([])
const editor_mode = ref<'edit' | 'preview'>('edit')

const editor_modes = [
  { label: '编辑', value: 'edit', icon: 'lucide:pencil' },
  { label: '预览', value: 'preview', icon: 'lucide:eye' },
]

let view: EditorView | null = null
const theme_compartment = new Compartment()

const markdownlint_config = {
  default: true,
  // Chinese prose wraps poorly with a line-length rule; title lives in front
  // matter (MD025 enforces no repeated H1 in the body) so MD041 is off too.
  // Plain fenced code blocks without a language are common in stories.
  MD013: false,
  MD033: false,
  MD040: false,
  MD041: false,
}
const front_matter_pattern = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/

function build_diagnostics(doc_text: string, doc: Text): Diagnostic[] {
  const diagnostics: Diagnostic[] = []

  for (const issue of parse_story_markdown(doc_text).issues) {
    const line = doc.line(Math.min(issue.line, doc.lines))
    diagnostics.push({
      from: line!.from,
      to: line.to,
      severity: 'error',
      message: issue.message,
      source: 'front-matter',
    })
  }

  try {
    const results = markdownlint({
      strings: { story: doc_text },
      config: markdownlint_config,
      frontMatter: front_matter_pattern,
    })
    for (const item of results.story ?? []) {
      const line = doc.line(Math.min(item.lineNumber, doc.lines))
      const range = item.errorRange as [number, number] | null
      const from = range ? Math.min(line.from + range[0] - 1, line.to) : line.from
      const to = range ? Math.min(from + range[1], line.to) : line.to
      diagnostics.push({
        from,
        to: Math.max(to, from),
        severity: 'warning',
        message: item.errorDetail ? `${item.ruleDescription} (${item.errorDetail})` : item.ruleDescription,
        source: item.ruleNames[0] ?? 'markdownlint',
      })
    }
  }
  catch {
    // markdownlint failures must never break editing
  }

  return diagnostics
}

function diagnostics_to_items(diagnostics: Diagnostic[], doc: Text): LintListItem[] {
  return diagnostics.map(diagnostic => ({
    from: diagnostic.from,
    line: doc.lineAt(diagnostic.from).number,
    message: diagnostic.message,
    source: diagnostic.source ?? null,
  }))
}

const initial_doc = EditorState.create({ doc: model.value }).doc
issues.value = diagnostics_to_items(build_diagnostics(model.value, initial_doc), initial_doc)

const lint_source = linter((editor_view) => {
  const diagnostics = build_diagnostics(editor_view.state.doc.toString(), editor_view.state.doc)

  if (view) {
    const items = diagnostics_to_items(diagnostics, editor_view.state.doc)
    issues.value = items
    emit('lint', items)
  }

  return diagnostics
}, { delay: 400 })

const light_theme = EditorView.theme({
  '&': { backgroundColor: 'transparent', color: '#1e293b', height: '100%' },
  '.cm-gutters': { backgroundColor: 'transparent', color: '#94a3b8', border: 'none' },
  '.cm-foldGutter': { display: 'none !important' },
  '.cm-activeLine': { backgroundColor: 'rgba(148, 163, 184, 0.12)' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': { backgroundColor: 'rgba(14, 165, 233, 0.18)' },
  '.cm-cursor': { borderLeftColor: '#0f172a' },
  '.cm-lintRange-error': { textDecorationColor: '#ef4444' },
  '.cm-lintRange-warning': { textDecorationColor: '#f59e0b' },
}, { dark: false })

const dark_theme = EditorView.theme({
  '&': { backgroundColor: 'transparent', color: '#e2e8f0', height: '100%' },
  '.cm-gutters': { backgroundColor: 'transparent', color: '#64748b', border: 'none' },
  '.cm-foldGutter': { display: 'none !important' },
  '.cm-activeLine': { backgroundColor: 'rgba(148, 163, 184, 0.08)' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': { backgroundColor: 'rgba(56, 189, 248, 0.22)' },
  '.cm-cursor': { borderLeftColor: '#f8fafc' },
  '.cm-lintRange-error': { textDecorationColor: '#f87171' },
  '.cm-lintRange-warning': { textDecorationColor: '#fbbf24' },
}, { dark: true })

// basicSetup's defaultHighlightStyle is light-oriented (#219 urls, #a11
// strings, ...) and unreadable on the dark background, so each mode gets its
// own palette instead of relying on the fallback.
const light_highlight = HighlightStyle.define([
  { tag: tags.heading, color: '#0f172a', fontWeight: 'bold' },
  { tag: tags.link, color: '#0369a1', textDecoration: 'underline' },
  { tag: tags.url, color: '#0284c7' },
  { tag: [tags.labelName, tags.processingInstruction, tags.contentSeparator], color: '#94a3b8' },
  { tag: tags.quote, color: '#64748b' },
  { tag: [tags.monospace, tags.string], color: '#15803d' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strong, fontWeight: 'bold' },
  { tag: tags.strikethrough, textDecoration: 'line-through' },
  { tag: [tags.escape, tags.character], color: '#b45309' },
  { tag: tags.comment, color: '#94a3b8' },
])

const dark_highlight = HighlightStyle.define([
  { tag: tags.heading, color: '#f1f5f9', fontWeight: 'bold' },
  { tag: tags.link, color: '#7dd3fc', textDecoration: 'underline' },
  { tag: tags.url, color: '#38bdf8' },
  { tag: [tags.labelName, tags.processingInstruction, tags.contentSeparator], color: '#64748b' },
  { tag: tags.quote, color: '#94a3b8' },
  { tag: [tags.monospace, tags.string], color: '#86efac' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strong, fontWeight: 'bold' },
  { tag: tags.strikethrough, textDecoration: 'line-through' },
  { tag: [tags.escape, tags.character], color: '#fbbf24' },
  { tag: tags.comment, color: '#64748b' },
])

function theme_extensions(mode: 'light' | 'dark') {
  return mode === 'dark'
    ? [dark_theme, syntaxHighlighting(dark_highlight)]
    : [light_theme, syntaxHighlighting(light_highlight)]
}

onMounted(() => {
  view = new EditorView({
    parent: editor_host.value!,
    state: EditorState.create({
      doc: model.value,
      extensions: [
        basicSetup,
        markdown_lang({ extensions: { remove: ['SetextHeading'] } }),
        lint_source,
        lintGutter(),
        theme_compartment.of(theme_extensions(color_mode.value)),
        EditorView.lineWrapping,
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            model.value = update.state.doc.toString()
          }
        }),
        EditorView.contentAttributes.of({ 'aria-label': '档案内容 Markdown 编辑器' }),
      ],
    }),
  })
  editor_ready.value = true
  void nextTick(() => view?.requestMeasure())
})

onBeforeUnmount(() => {
  view?.destroy()
  view = null
})

watch(color_mode, (mode) => {
  view?.dispatch({
    effects: theme_compartment.reconfigure(theme_extensions(mode)),
  })
})

watch(model, (value) => {
  if (view && value !== view.state.doc.toString()) {
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: value },
    })
  }
})

function jump_to_line(from: number) {
  if (! view)
    return
  view.dispatch({ selection: { anchor: from }, scrollIntoView: true })
  view.focus()
}

function insert_at_position(text: string, from: number, to = from) {
  if (! view)
    return

  const doc = view.state.doc
  const char_before = from > 0 ? doc.sliceString(from - 1, from) : ''
  const char_after = from < doc.length ? doc.sliceString(from, from + 1) : ''

  let prefix = ''
  let suffix = ''

  if (char_before && char_before !== '\n') {
    prefix = '\n'
  }
  if (from >= doc.length || (char_after && char_after !== '\n')) {
    suffix = '\n'
  }

  const insert_text = `${prefix}${text}${suffix}`

  view.dispatch({
    changes: { from, to, insert: insert_text },
    selection: { anchor: from + insert_text.length },
  })
  view.focus()
}

defineExpose({
  insert_at_position,
})

function on_drop(event: DragEvent) {
  drag_over.value = false
  const dropped_files = event.dataTransfer?.files ? [...event.dataTransfer.files] : []
  if (dropped_files.length) {
    const position = view ? (view.posAtCoords({ x: event.clientX, y: event.clientY }) ?? view.state.selection.main.from) : null
    emit('files-dropped', dropped_files, position)
    return
  }

  const attachment = get_content_attachment_drag_data(event.dataTransfer)
  if (attachment && view) {
    const position = view.posAtCoords({ x: event.clientX, y: event.clientY }) ?? view.state.selection.main.from
    insert_at_position(content_attachment_markdown(attachment), position)
  }
}

function on_drag_over(event: DragEvent) {
  drag_over.value = true
  if (event.dataTransfer) {
    event.dataTransfer.dropEffect = 'copy'
  }
}
</script>

<style scoped>
:deep(.cm-editor) {
  @apply min-h-80 max-h-[60vh] text-sm;
}

:deep(.cm-scroller) {
  @apply overflow-auto font-mono leading-relaxed;
}

:deep(.cm-editor.cm-focused) {
  @apply outline-none;
}

:deep(.cm-tooltip) {
  @apply rounded-sm overflow-hidden border border-slate-200 bg-white text-xs text-slate-700 shadow-sm dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200;
}
</style>
