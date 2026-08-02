<template>
  <div class="space-y-2">
    <div class="flex flex-wrap items-center justify-between gap-2">
      <slot name="toolbar-start" />
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
      </div>
    </div>

    <div
      v-show="editor_mode === 'edit'"
      class="overflow-hidden rounded-sm border border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900"
      :class="{
        'border-dashed border-brand-400 dark:border-brand-600': drag_over,
        'editor-mode-enter': mode_has_switched && editor_mode === 'edit',
      }"
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

      <div
        v-if="search_open"
        class="relative flex flex-col gap-y-2 border-t border-slate-200 bg-slate-50 p-3 dark:border-slate-700 dark:bg-slate-800/50 overflow-hidden"
      >
        <Button
          text
          rounded
          severity="secondary"
          aria-label="关闭查找替换"
          class="!absolute -right-2 -top-2"
          @click="close_search"
        >
          <template #icon>
            <MyIcon name="lucide:x" class="text-xl" />
          </template>
        </Button>
        <div class="flex flex-wrap items-center gap-x-3 gap-y-2 pr-8">
          <InputText
            ref="search_input"
            v-model="search_query"
            size="small"
            placeholder="查找"
            aria-label="查找"
            class="min-w-[10rem] flex-1"
            @keydown="on_find_input_keydown"
            @keydown.esc.prevent="close_search"
          />
          <span class="min-w-[3.5rem] text-right font-mono text-xs text-slate-400 dark:text-slate-500" aria-live="polite">
            {{ match_status_text }}
          </span>
          <div class="flex items-center gap-1">
            <Button size="small" severity="secondary" outlined label="上一个" :disabled="! match_count" @click="find_previous" />
            <Button size="small" severity="secondary" outlined label="下一个" :disabled="! match_count" @click="find_next" />
            <Button size="small" severity="secondary" outlined label="全部选中" :disabled="! match_count" @click="select_all_matches" />
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
            v-model="replace_query"
            size="small"
            placeholder="替换为"
            aria-label="替换为"
            class="min-w-[10rem] flex-1"
            @keydown.enter.prevent="replace_current"
            @keydown.esc.prevent="close_search"
          />
          <div class="flex items-center gap-1">
            <Button size="small" severity="secondary" outlined label="替换" :disabled="! match_count" @click="replace_current" />
            <Button size="small" severity="secondary" outlined label="全部替换" :disabled="! match_count" @click="replace_all" />
          </div>
        </div>
      </div>
    </div>

    <div
      v-show="editor_mode === 'preview'"
      class="min-h-80 overflow-hidden rounded-sm border border-slate-200 bg-white p-5 dark:border-slate-700 dark:bg-slate-900"
      :class="{ 'editor-mode-enter': mode_has_switched && editor_mode === 'preview' }"
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
import type { DecorationSet } from '@codemirror/view'
import type { ContentStoryAttachment } from '@shared/types/content'
import { markdown as markdown_lang } from '@codemirror/lang-markdown'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { linter, lintGutter } from '@codemirror/lint'
import { Compartment, EditorSelection, EditorState, Prec, StateEffect, StateField } from '@codemirror/state'
import { Decoration, EditorView, keymap } from '@codemirror/view'
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
const content_markdown_config = useContentMarkdownConfig()

const editor_host = ref<HTMLElement>()
const editor_ready = ref(false)
const drag_over = ref(false)
const issues = ref<LintListItem[]>([])
const editor_mode = ref<'edit' | 'preview'>('edit')
const mode_has_switched = ref(false)

const editor_modes = [
  { label: '编辑', value: 'edit', icon: 'lucide:pencil' },
  { label: '预览', value: 'preview', icon: 'lucide:eye' },
]

const search_open = ref(false)
const search_query = ref('')
const replace_query = ref('')
const match_case = ref(false)
const match_regexp = ref(false)
const match_word = ref(false)
const match_count = ref(0)
const match_active = ref(- 1)
const search_input = ref<{ $el: HTMLInputElement } | null>(null)

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

function build_diagnostics(doc_text: string, doc: Text) {
  const diagnostics: Diagnostic[] = []

  for (const issue of parse_story_markdown(doc_text, content_markdown_config).issues) {
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

function diagnostics_to_items(diagnostics: Diagnostic[], doc: Text) {
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

interface SearchSpec {
  query: string
  case_sensitive: boolean
  regexp: boolean
  whole_word: boolean
}

interface SearchMatch {
  from: number
  to: number
}

interface SearchFieldValue {
  spec: SearchSpec | null
  matches: SearchMatch[]
  active: number
  decorations: DecorationSet
}

const set_search_spec_effect = StateEffect.define<SearchSpec | null>()
const search_match_mark = Decoration.mark({ class: 'cm-search-hit' })
const search_active_mark = Decoration.mark({ class: 'cm-search-hit-active' })

function escape_regexp_source(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function build_search_source(spec: SearchSpec) {
  if (! spec.query)
    return null
  let source = spec.regexp ? spec.query : escape_regexp_source(spec.query)
  if (spec.whole_word) {
    if (/^\w/.test(source))
      source = `\\b${source}`
    if (/\w$/.test(source))
      source = `${source}\\b`
  }
  return source
}

function build_search_regex(spec: SearchSpec) {
  const source = build_search_source(spec)
  if (! source)
    return null
  try {
    return new RegExp(source, spec.case_sensitive ? 'g' : 'gi')
  }
  catch {
    return null
  }
}

function collect_search_matches(spec: SearchSpec, state: EditorState) {
  const matches: SearchMatch[] = []
  const regex = build_search_regex(spec)
  if (! regex)
    return matches
  const text = state.doc.toString()
  for (;;) {
    const result = regex.exec(text)
    if (result === null)
      break
    matches.push({ from: result.index, to: result.index + result[0].length })
    if (result[0].length === 0)
      regex.lastIndex += 1
  }
  return matches
}

const search_field = StateField.define<SearchFieldValue>({
  create: () => ({ spec: null, matches: [], active: - 1, decorations: Decoration.none }),
  update(value, tr) {
    let spec = value.spec
    for (const effect of tr.effects) {
      if (effect.is(set_search_spec_effect))
        spec = effect.value
    }
    if (! spec)
      return { spec: null, matches: [], active: - 1, decorations: Decoration.none }
    if (spec === value.spec && ! tr.docChanged && tr.newSelection === tr.startState.selection)
      return value
    const matches = collect_search_matches(spec, tr.state)
    const head = tr.state.selection.main.head
    let active = matches.findIndex(match => match.from <= head && head <= match.to)
    if (active === - 1)
      active = matches.findIndex(match => match.from >= head)
    const marks = matches.flatMap((match, index) => {
      if (match.to === match.from)
        return []
      return [(index === active ? search_active_mark : search_match_mark).range(match.from, match.to)]
    })
    return { spec, matches, active, decorations: Decoration.set(marks, true) }
  },
  provide: field => EditorView.decorations.from(field, value => value.decorations),
})

function current_search_spec() {
  return {
    query: search_query.value,
    case_sensitive: match_case.value,
    regexp: match_regexp.value,
    whole_word: match_word.value,
  }
}

const search_regex_invalid = computed(() => {
  if (! search_query.value || ! match_regexp.value)
    return false
  return build_search_regex(current_search_spec()) === null
})

const match_status_text = computed(() => {
  if (! search_query.value)
    return ''
  if (search_regex_invalid.value)
    return '正则表达式无效'
  if (! match_count.value)
    return '无结果'
  if (match_active.value < 0)
    return `共 ${match_count.value} 处`
  return `${match_active.value + 1}/${match_count.value}`
})

function sync_search_spec() {
  if (! view || ! search_open.value)
    return
  view.dispatch({ effects: set_search_spec_effect.of(current_search_spec()) })
}

watch([search_query, match_case, match_regexp, match_word], sync_search_spec)

watch(editor_mode, (mode) => {
  mode_has_switched.value = true
  if (mode !== 'edit')
    close_search()
})

function open_search() {
  search_open.value = true
  if (view) {
    const selection = view.state.selection.main
    if (! selection.empty) {
      const selected = view.state.sliceDoc(selection.from, selection.to)
      if (! selected.includes('\n'))
        search_query.value = selected
    }
  }
  sync_search_spec()
  void nextTick(() => search_input.value?.$el.select())
}

function close_search() {
  if (! search_open.value)
    return
  search_open.value = false
  match_count.value = 0
  match_active.value = - 1
  view?.dispatch({ effects: set_search_spec_effect.of(null) })
  view?.focus()
}

function select_match(match: SearchMatch) {
  view?.dispatch({
    selection: { anchor: match.from, head: match.to },
    effects: EditorView.scrollIntoView(EditorSelection.range(match.from, match.to), { y: 'center' }),
    userEvent: 'select.search',
  })
}

function step_match(direction: 1 | - 1) {
  if (! view)
    return
  const { matches } = view.state.field(search_field)
  if (! matches.length)
    return
  const selection = view.state.selection.main
  let index: number
  if (direction === 1) {
    const start = selection.empty ? selection.head : selection.from + 1
    index = matches.findIndex(match => match.from >= start)
    if (index === - 1)
      index = 0
  }
  else {
    const start = selection.empty ? selection.head : selection.to - 1
    index = matches.length - 1
    while (index >= 0 && matches[index]!.to > start)
      index -= 1
    if (index < 0)
      index = matches.length - 1
  }
  select_match(matches[index]!)
}

function find_next() {
  step_match(1)
}

function find_previous() {
  step_match(- 1)
}

function select_all_matches() {
  if (! view)
    return
  const { matches } = view.state.field(search_field)
  if (! matches.length)
    return
  view.dispatch({
    selection: EditorSelection.create(matches.map(match => EditorSelection.range(match.from, match.to))),
    userEvent: 'select.search.all',
  })
}

function replacement_text(spec: SearchSpec, matched: string) {
  if (! spec.regexp)
    return replace_query.value
  const source = build_search_source(spec)
  if (! source)
    return null
  try {
    return matched.replace(new RegExp(`^(?:${source})$`, spec.case_sensitive ? '' : 'i'), replace_query.value)
  }
  catch {
    return null
  }
}

function replace_current() {
  if (! view)
    return
  const field_value = view.state.field(search_field)
  const spec = field_value.spec
  if (! spec)
    return
  const selection = view.state.selection.main
  const match = field_value.matches.find(item => item.from === selection.from && item.to === selection.to)
  if (! match) {
    find_next()
    return
  }
  const replacement = replacement_text(spec, view.state.sliceDoc(match.from, match.to))
  if (replacement === null)
    return
  view.dispatch({
    changes: { from: match.from, to: match.to, insert: replacement },
    selection: { anchor: match.from + replacement.length },
    userEvent: 'input.replace',
  })
  find_next()
}

function replace_all() {
  if (! view)
    return
  const field_value = view.state.field(search_field)
  const spec = field_value.spec
  if (! spec || ! field_value.matches.length)
    return
  const changes: { from: number, to: number, insert: string }[] = []
  for (const match of field_value.matches) {
    const replacement = replacement_text(spec, view.state.sliceDoc(match.from, match.to))
    if (replacement === null)
      return
    changes.push({ from: match.from, to: match.to, insert: replacement })
  }
  view.dispatch({ changes, userEvent: 'input.replace.all' })
}

function on_find_input_keydown(event: KeyboardEvent) {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
    event.preventDefault()
    search_input.value?.$el.select()
    return
  }
  if (event.key !== 'Enter')
    return
  event.preventDefault()
  if (event.shiftKey)
    find_previous()
  else
    find_next()
}

onMounted(() => {
  view = new EditorView({
    parent: editor_host.value!,
    state: EditorState.create({
      doc: model.value,
      extensions: [
        basicSetup,
        Prec.highest(keymap.of([
          {
            key: 'Mod-f',
            run: () => {
              open_search()
              return true
            },
          },
          {
            key: 'Escape',
            run: () => {
              if (! search_open.value)
                return false
              close_search()
              return true
            },
          },
        ])),
        markdown_lang({ extensions: { remove: ['SetextHeading'] } }),
        lint_source,
        lintGutter(),
        search_field,
        theme_compartment.of(theme_extensions(color_mode.value)),
        EditorView.lineWrapping,
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            model.value = update.state.doc.toString()
          }
          if (search_open.value) {
            const field_value = update.state.field(search_field)
            match_count.value = field_value.matches.length
            match_active.value = field_value.active
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
  const dropped_files = event.dataTransfer?.files ? [... event.dataTransfer.files] : []
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

:deep(.cm-search-hit) {
  @apply rounded-sm bg-amber-200/70 dark:bg-amber-500/30;
}

:deep(.cm-search-hit-active) {
  @apply bg-amber-300 dark:bg-amber-400/50;
}

/* basicSetup's selection-match marks would double-highlight search hits */
:deep(.cm-selectionMatch) {
  @apply !bg-transparent;
}

.editor-mode-enter {
  animation: editor-mode-enter 240ms cubic-bezier(0.16, 1, 0.3, 1) both;
}

@keyframes editor-mode-enter {
  from {
    opacity: 0;
  }
}

@media (prefers-reduced-motion: reduce) {
  .editor-mode-enter {
    animation: none;
  }
}
</style>
