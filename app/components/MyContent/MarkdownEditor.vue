<template>
  <div class="space-y-2">
    <!-- Preload the lucide icons used as completion-type icons so the
         injected `iconify` spans in the autocomplete list render. -->
    <div class="hidden" aria-hidden="true">
      <MyIcon v-for="icon in completion_icon_names" :key="icon" :name="icon" />
    </div>

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
          link
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
      class="section-card-collapse"
      :class="{ 'editor-mode-enter': mode_has_switched && editor_mode === 'preview' }"
    >
      <MyContentMarkdownPreview :markdown="model" :story-id="storyId" :attachments="attachments" :stories="stories" empty-text="暂无可预览内容" />
    </div>

    <div v-if="editor_mode === 'edit' && issues.length" class="rounded-sm border border-slate-200 bg-slate-50 dark:border-slate-700 dark:bg-slate-800/50 overflow-hidden">
      <div class="overflow-y-auto max-h-64 p-2">
        <button
          v-for="(issue, index) in issues"
          :key="index"
          type="button"
          class="flex w-full items-start gap-2 rounded px-2 py-1 text-left text-xs transition-[background-color] hover:bg-slate-100 dark:hover:bg-slate-700/50"
          @click="jump_to_line(issue.from)"
        >
          <span class="shrink-0 font-mono text-slate-400">第 {{ issue.line }} 行</span>
          <span class="text-slate-600 dark:text-slate-300">{{ issue.message }}</span>
          <span v-if="issue.source" class="ml-auto shrink-0 font-mono text-slate-400">{{ issue.source }}</span>
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { Completion, CompletionContext, CompletionResult } from '@codemirror/autocomplete'
import type { Diagnostic } from '@codemirror/lint'
import type { Text } from '@codemirror/state'
import type { DecorationSet, ViewUpdate } from '@codemirror/view'
import type { ContentMarkdownConfig } from '@shared/content-markdown'
import type { ContentStoryAttachment, ContentStorySummary } from '@shared/types/content'
import type { Configuration as MarkdownlintConfiguration } from 'markdownlint'
import { autocompletion, startCompletion } from '@codemirror/autocomplete'
import { html as html_lang, htmlLanguage } from '@codemirror/lang-html'
import { markdown as markdown_lang, markdownLanguage } from '@codemirror/lang-markdown'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { forceLinting, linter, lintGutter } from '@codemirror/lint'
import { Compartment, EditorSelection, EditorState, Prec, StateEffect, StateField } from '@codemirror/state'
import { Decoration, EditorView, keymap, MatchDecorator, ViewPlugin } from '@codemirror/view'
import { tags } from '@lezer/highlight'
import { parse_story_markdown } from '@shared/content-markdown'
import { content_rating_tiers, pinned_label, rating_label, story_rating } from '@shared/types/content'
import { basicSetup } from 'codemirror'
import { lint as markdownlint } from 'markdownlint/sync'
import { content_attachment_markdown, get_content_attachment_drag_data } from '~/utils/content/attachment-drag'
import { html_markdown_wrapper_tags } from '~/utils/content/html'

interface LintListItem {
  from: number
  line: number
  message: string
  source: string | null
}

const props = withDefaults(defineProps<{
  storyId?: number | null
  attachments?: ContentStoryAttachment[]
  placeholder?: string
  /** Known stories for `@story` completion, dead-reference linting and preview cards. */
  stories?: ContentStorySummary[]
}>(), {
  storyId: null,
  attachments: () => [],
  placeholder: '',
  stories: () => [],
})

const emit = defineEmits<{
  'lint': [issues: LintListItem[]]
  'files-dropped': [files: File[], position: number | null]
}>()

const model = defineModel<string>({ default: '' })

const color_mode = useMyColorMode()
const { public: public_config } = useRuntimeConfig()

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

const markdownlint_config: MarkdownlintConfiguration = {
  default: 'error',
  MD013: false,
  MD025: false,
  MD033: false,
  MD045: false,
}
const front_matter_pattern = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/

// True when the HTML parse of `region_text` still has an element open (its
// last child is the OpenTag, not a CloseTag). Used to group adjacent HTML
// nodes: a wrapper split by a blank line (`<center>` ... `</center>`) stays
// in one region until its close tag arrives.
function html_region_has_unclosed(region_text: string) {
  const tree = htmlLanguage.parser.parse(region_text)
  let unclosed = false
  tree.iterate({ enter: (n) => {
    if (n.type.name === 'Element') {
      const last = n.node.lastChild
      if (last && last.type.name === 'OpenTag') {
        unclosed = true
      }
    }
  } })
  return unclosed
}

// Grammar-check the HTML blocks/tags in the markdown body with the lezer HTML
// parser, reporting malformed open tags (unclosed quote / missing `>`),
// mismatched close tags, and elements missing their close tag. Only tag
// structure is checked — text content (markdown) is never treated as HTML.
function build_html_diagnostics(doc_text: string): Diagnostic[] {
  const diagnostics: Diagnostic[] = []
  const tree = markdownLanguage.parser.parse(doc_text)
  const html_nodes: { from: number, to: number }[] = []
  tree.iterate({ enter: (n) => {
    if (n.type.name === 'HTMLBlock' || n.type.name === 'HTMLTag') {
      html_nodes.push({ from: n.from, to: n.to })
    }
  } })
  if (! html_nodes.length) {
    return diagnostics
  }

  // Group adjacent HTML nodes into regions: keep absorbing nodes while the
  // accumulated text still has unclosed elements, so a wrapper split by a
  // blank line rejoins into a single region before linting.
  const regions: { from: number, to: number }[][] = []
  let current: { from: number, to: number }[] = []
  for (let i = 0; i < html_nodes.length; i ++) {
    current.push(html_nodes[i]!)
    const region_text = current.map(n => doc_text.slice(n.from, n.to)).join('\n')
    if (! html_region_has_unclosed(region_text) || i === html_nodes.length - 1) {
      regions.push(current)
      current = []
    }
  }

  for (const region_nodes of regions) {
    // Concatenate the node texts and remember each region offset's doc offset,
    // so diagnostics found in the region can be mapped back to the document.
    const parts: string[] = []
    const map: number[] = []
    for (let i = 0; i < region_nodes.length; i ++) {
      const node = region_nodes[i]!
      if (i > 0) {
        parts.push('\n')
        map.push(- 1)
      }
      for (let p = node.from; p < node.to; p ++) {
        parts.push(doc_text[p]!)
        map.push(p)
      }
    }
    const region_text = parts.join('')
    const to_doc = (region_from: number, region_to: number) => {
      const from = map[region_from] ?? - 1
      const to = region_to > region_from ? (map[region_to - 1] ?? - 1) + 1 : from + 1
      return { from, to }
    }

    const ht = htmlLanguage.parser.parse(region_text)
    ht.iterate({ enter: (n) => {
      const name = n.type.name
      if (name === 'OpenTag' && ! n.node.getChild('EndTag')) {
        // Unclosed open tag: a missing `>` or an unterminated attribute quote.
        const tag = n.node.getChild('TagName')
        const { from, to } = to_doc(tag?.from ?? n.from, tag?.to ?? n.to)
        if (from >= 0) {
          diagnostics.push({
            from,
            to: Math.max(to, from + 1),
            severity: 'error',
            message: 'HTML 标签未正确闭合（属性引号或 > 缺失）',
            source: 'html',
          })
        }
      }
      else if (name === 'MismatchedCloseTag') {
        const parent_tag = n.node.parent?.getChild('OpenTag')?.getChild('TagName')
        const expected = parent_tag ? region_text.slice(parent_tag.from, parent_tag.to) : null
        const close_text = region_text.slice(n.from, n.to)
        const { from, to } = to_doc(n.from, n.to)
        if (from >= 0) {
          diagnostics.push({
            from,
            to: Math.max(to, from + 1),
            severity: 'error',
            message: expected
              ? `闭合标签 ${close_text} 与 <${expected}> 不匹配，应为 </${expected}>`
              : `多余的闭合标签 ${close_text}`,
            source: 'html',
          })
        }
      }
      else if (name === 'Element') {
        const open = n.node.getChild('OpenTag')
        const close = n.node.getChild('CloseTag')
        const last = n.node.lastChild
        if (open && open.getChild('EndTag') && ! close && last?.type.name !== 'MismatchedCloseTag') {
          const tag = open.getChild('TagName')
          const tag_name = tag ? region_text.slice(tag.from, tag.to) : '?'
          const { from, to } = to_doc(tag?.from ?? open.from, tag?.to ?? open.to)
          if (from >= 0) {
            diagnostics.push({
              from,
              to: Math.max(to, from + 1),
              severity: 'error',
              message: `缺少闭合标签 </${tag_name}>`,
              source: 'html',
            })
          }
        }
      }
    } })
  }

  return diagnostics
}

function build_diagnostics(doc_text: string, doc: Text) {
  const diagnostics: Diagnostic[] = []

  const content_markdown_config: ContentMarkdownConfig = {
    title_max_length: public_config.content_story_title_max_length,
    label_max_bytes: public_config.content_story_label_max_bytes,
    desc_max_bytes: public_config.content_story_desc_max_bytes,
    cover_max_bytes: public_config.content_story_cover_max_bytes,
    markdown_max_bytes: public_config.content_story_markdown_max_bytes,
    existing_titles: props.stories
      .filter(story => story.id !== props.storyId)
      .map(story => ({ id: story.id, title: story.title })),
  }
  for (const issue of parse_story_markdown(doc_text, content_markdown_config).issues) {
    const line = doc.line(Math.min(issue.line, doc.lines))
    diagnostics.push({
      from: line!.from,
      to: line.to,
      severity: issue.severity,
      message: issue.message,
      source: issue.source,
    })
  }

  diagnostics.push(... build_html_diagnostics(doc_text))

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

// `@` story completion: `[](@query` completes to `[](@title)`, a bare `@query`
// to a wrapped `[](@title)`. Titles cannot contain spaces or `@`, so the
// destination is a single clean token.
const story_at_patterns = {
  link: /\((@[\p{L}\p{N}_]*)$/u,
  bare: /(?:^|[\s(])(@[\p{L}\p{N}_]*)$/u,
}
const story_at_valid = /^@[\p{L}\p{N}_]*$/u

function story_completion_source(context: CompletionContext): CompletionResult | null {
  const before = context.state.sliceDoc(0, context.pos)
  const link_match = story_at_patterns.link.exec(before)
  const bare_match = link_match ? null : story_at_patterns.bare.exec(before)
  const match = link_match ?? bare_match
  if (! match) {
    return null
  }
  const in_link = Boolean(link_match)
  const options: Completion[] = props.stories
    .filter(story => story.id !== props.storyId)
    .map(story => ({
      // The label carries the `@` prefix so CodeMirror's built-in filter can
      // match the `@query` token; `displayLabel` keeps the `@` out of the list.
      label: `@${story.title}`,
      displayLabel: story.title,
      detail: story_rating(story.labels),
      type: 'story',
      // Inside `[](@` the user already typed the parens (closeBrackets adds
      // the closing `)`), so only the `@title` token is replaced; a bare `@`
      // wraps into a full `[](@title)` link.
      apply: in_link ? `@${story.title}` : `[](@${story.title})`,
    }))
  return {
    // Replace the `@query` token (never the leading whitespace/`(`), so the
    // surrounding `[](` / closeBrackets `)` stay put. The built-in filter
    // scores prefix matches first; `validFor` keeps the result alive while
    // the user types inside the `@token` so the list narrows in place.
    from: match.index + match[0].indexOf('@'),
    to: context.pos,
    options,
    validFor: story_at_valid,
  }
}

// Custom completion types render a lucide icon in the list (including
// `keyword`, replacing CodeMirror's built-in glyph). The iconify classes are
// preloaded by the hidden MyIcon row above so the injected spans display.
const completion_icon_by_type: Record<string, string> = {
  story: 'lucide:book-open',
  file: 'lucide:file',
  image: 'lucide:image',
  keyword: 'lucide:tag',
}
const completion_icon_names = [... new Set(Object.values(completion_icon_by_type))]

// Injects the type icon into an autocomplete option; returns null for types
// without a custom icon so their default glyph stays.
function completion_icon_renderer(completion: Completion): Node | null {
  const icon = completion.type ? completion_icon_by_type[completion.type] : undefined
  if (! icon) {
    return null
  }
  const span = document.createElement('span')
  span.className = `completion-type-icon iconify i-${icon}`
  span.setAttribute('aria-hidden', 'true')
  return span
}

const autocomplete_ext = autocompletion({
  override: [story_completion_source, attachment_completion_source, label_completion_source, alert_marker_completion_source],
  addToOptions: [{
    render: completion_icon_renderer,
    position: 20,
  }],
})

// Attachment file-name completion: offered inside a link destination `[](` /
// `![](` before any `/`, scheme, `@`, `#` or `)` is typed, so it only fires for
// bare story-relative file names. Options carry the file name; the built-in
// filter narrows as the user types.
const attachment_dest_pattern = /!?\[[^\]]*\]\(\s*([^)\s<>]*)$/
const attachment_dest_valid = /^[^/@#:)\s<>]*$/

function attachment_completion_source(context: CompletionContext): CompletionResult | null {
  const before = context.state.sliceDoc(0, context.pos)
  const match = attachment_dest_pattern.exec(before)
  if (! match) {
    return null
  }
  const query = match[1] ?? ''
  if (! attachment_dest_valid.test(query)) {
    return null
  }
  const options: Completion[] = props.attachments.map(attachment => ({
    label: attachment.file_name,
    detail: attachment.is_image ? '图片' : '附件',
    type: attachment.is_image ? 'image' : 'file',
    apply: attachment.file_name,
  }))
  return {
    from: context.pos - query.length,
    to: context.pos,
    options,
    validFor: attachment_dest_valid,
  }
}

// Special `#`-prefixed labels (rating tiers + pin) on the front-matter `label:`
// line, so a bare `#` lists the allowed hidden tags.
const special_labels = [... content_rating_tiers.map(rating_label), pinned_label]
// Ordinary (non-`#`) labels already in use across OTHER stories (the story
// being edited is excluded — its DB labels are already on its own label line),
// deduplicated, so typing a plain label word can reuse an existing tag.
const existing_labels = computed(() => {
  const labels = new Set<string>()
  for (const story of props.stories) {
    if (story.id === props.storyId) {
      continue
    }
    for (const label of story.labels) {
      if (! label.startsWith('#')) {
        labels.add(label)
      }
    }
  }
  return [... labels].sort((a, b) => a.localeCompare(b, 'zh-CN'))
})
const label_line_pattern = /^label\s*:/i
// The first label token follows the `label:` colon directly (no space needed),
// so the boundary accepts line start, whitespace, or the colon itself.
const label_token_pattern = /(?:^|[\s:])(#[^#\s]*|[^#\s]*)$/
// Shape-specific validFor: `#`-prefixed queries keep only `#…` results alive,
// plain queries keep only plain `…`. The old `#?`-optional pattern matched BOTH
// forms, so typing `#` while a plain-label result was active never invalidated
// it — CodeMirror kept the stale result instead of re-querying the source.
const label_hash_valid = /^#[\p{L}\p{N}_]*$/u
const label_plain_valid = /^[\p{L}\p{N}_]*$/u

function label_completion_source(context: CompletionContext): CompletionResult | null {
  const before = context.state.sliceDoc(0, context.pos)
  const line_start = before.lastIndexOf('\n') + 1
  const line = before.slice(line_start)
  if (! label_line_pattern.test(line)) {
    return null
  }
  const token_match = label_token_pattern.exec(line)
  if (! token_match) {
    return null
  }
  const query = token_match[1] ?? ''
  const is_hash = query.startsWith('#')
  const candidates = is_hash ? special_labels : existing_labels.value
  if (! candidates.length) {
    return null
  }
  const options: Completion[] = candidates.map(label => ({
    label,
    type: 'keyword',
    apply: label,
  }))
  return {
    from: context.pos - query.length,
    to: context.pos,
    options,
    validFor: is_hash ? label_hash_valid : label_plain_valid,
  }
}

// Blockquote alert markers `> [!NOTE]` etc. complete the marker after `[!`.
// Requires at least one `>` so the marker is suggested only where it will
// actually render as an alert (markdown-it needs a blockquote).
const alert_marker_pattern = /^[ \t]*(?:>[ \t]?)+\[![a-z]*$/i
const alert_marker_valid = /^\[![a-z]*$/i
const alert_markers = ['NOTE', 'TIP', 'IMPORTANT', 'WARNING', 'CAUTION'] as const
const alert_labels_map: Record<(typeof alert_markers)[number], string> = {
  NOTE: '提示',
  TIP: 'TIP',
  IMPORTANT: '重要提示',
  WARNING: '警告',
  CAUTION: '注意',
}

// Typing `[!` makes closeBrackets insert a `]` right after the cursor, so the
// marker's own `]` would stack into `[!NOTE]]`. Consume that auto-inserted `]`
// when the apply runs.
function apply_alert_marker(view: EditorView, completion: Completion, from: number, to: number) {
  const marker = completion.label
  const trailing_bracket = view.state.doc.sliceString(to, to + 1) === ']'
  const end = trailing_bracket ? to + 1 : to
  view.dispatch({
    changes: { from, to: end, insert: marker },
    selection: { anchor: from + marker.length },
    userEvent: 'input.complete',
  })
}

function alert_marker_completion_source(context: CompletionContext): CompletionResult | null {
  const before = context.state.sliceDoc(0, context.pos)
  // Match against the current line only: `^` would otherwise anchor to the
  // document start and never fire after the front matter or other content.
  const line_start = before.lastIndexOf('\n') + 1
  const line = before.slice(line_start)
  const match = alert_marker_pattern.exec(line)
  if (! match) {
    return null
  }
  const marker_from = line_start + line.lastIndexOf('[!')
  const options: Completion[] = alert_markers.map(marker => ({
    label: `[!${marker}]`,
    detail: alert_labels_map[marker],
    type: 'keyword',
    apply: apply_alert_marker,
  }))
  return {
    from: marker_from,
    to: context.pos,
    options,
    validFor: alert_marker_valid,
  }
}

const light_theme = EditorView.theme({
  '&': { backgroundColor: 'transparent', color: '#1e293b', height: '100%' },
  '.cm-gutters': { backgroundColor: 'transparent', color: '#94a3b8', border: 'none' },
  '.cm-foldGutter': { display: 'none !important' },
  '.cm-activeLine': { backgroundColor: 'rgba(148, 163, 184, 0.12)' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': { backgroundColor: 'rgba(14, 165, 233, 0.18)' },
  '.cm-cursor': { borderLeftColor: '#0f172a' },
  '.cm-lintRange-error': { textDecorationColor: '#ef4444' },
  '.cm-lintRange-warning': { textDecorationColor: '#f59e0b' },
  '.cm-alert-marker': { fontWeight: 'bold' },
  '.cm-alert-marker-note': { color: '#0369a1' },
  '.cm-alert-marker-tip': { color: '#047857' },
  '.cm-alert-marker-important': { color: '#4338ca' },
  '.cm-alert-marker-warning': { color: '#b45309' },
  '.cm-alert-marker-caution': { color: '#b91c1c' },
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
  '.cm-alert-marker': { fontWeight: 'bold' },
  '.cm-alert-marker-note': { color: '#38bdf8' },
  '.cm-alert-marker-tip': { color: '#34d399' },
  '.cm-alert-marker-important': { color: '#818cf8' },
  '.cm-alert-marker-warning': { color: '#fbbf24' },
  '.cm-alert-marker-caution': { color: '#f87171' },
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
  { tag: tags.tagName, color: '#b45309' },
  { tag: tags.attributeName, color: '#0f766e' },
  { tag: tags.attributeValue, color: '#15803d' },
  { tag: tags.angleBracket, color: '#94a3b8' },
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
  { tag: tags.tagName, color: '#fbbf24' },
  { tag: tags.attributeName, color: '#5eead4' },
  { tag: tags.attributeValue, color: '#86efac' },
  { tag: tags.angleBracket, color: '#64748b' },
])

function theme_extensions(mode: 'light' | 'dark') {
  return mode === 'dark'
    ? [dark_theme, syntaxHighlighting(dark_highlight)]
    : [light_theme, syntaxHighlighting(light_highlight)]
}

// Highlights `[!NOTE]`-style alert markers at the start of blockquote lines;
// colors mirror the preview's markdown-alert palette.
const alert_marker_decorator = new MatchDecorator({
  regexp: /^[ \t]*(?:>[ \t]?)+\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]/gm,
  decorate: (add, from, to, match) => {
    const marker_from = from + match[0].indexOf('[!')
    add(marker_from, to, Decoration.mark({ class: `cm-alert-marker cm-alert-marker-${match[1]!.toLowerCase()}` }))
  },
})

const alert_marker_plugin = ViewPlugin.fromClass(class {
  decorations: DecorationSet

  constructor(view: EditorView) {
    this.decorations = alert_marker_decorator.createDeco(view)
  }

  update(update: ViewUpdate) {
    this.decorations = alert_marker_decorator.updateDeco(update, this.decorations)
  }
}, { decorations: value => value.decorations })

// Markdown written inside HTML elements is parsed as markdown (emphasis,
// links, lists, ...), matching the preview renderer: every element except the
// raw-text/code/embedded blocklist.
//
// The nested parser must itself recognize nested HTML elements, so the
// markdown and html languages are wired to each other: the html language
// nests this same markdown language, which in turn nests the html language
// again, so `<center><center>...</center></center>` keeps recursing. The
// parser fields are filled in after both languages exist (configureNesting
// reads them lazily).
const markdown_inside_html_tags: { tag: string, parser: typeof markdownLanguage.parser }[]
  = html_markdown_wrapper_tags.map(tag => ({ tag, parser: markdownLanguage.parser }))

const editor_html_lang = html_lang({
  matchClosingTags: false,
  nestedLanguages: markdown_inside_html_tags,
})

const editor_markdown_lang = markdown_lang({
  extensions: { remove: ['SetextHeading'] },
  htmlTagLanguage: editor_html_lang,
})

for (const entry of markdown_inside_html_tags) {
  entry.parser = editor_markdown_lang.language.parser
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
        editor_markdown_lang,
        lint_source,
        lintGutter(),
        autocomplete_ext,
        search_field,
        alert_marker_plugin,
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
          // Backspacing alone never re-activates completion (CodeMirror only
          // re-queries on typing), so after a backward delete reopen it — the
          // source returns null when there's no `@` token, leaving the popup
          // closed in unrelated edits.
          if (update.transactions.some(tr => tr.isUserEvent('delete.backward'))) {
            startCompletion(update.view)
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

watch(() => props.stories, () => {
  // Re-run duplicate-title / dead-reference lints when the story list changes (e.g. after a sync refresh).
  if (view) {
    forceLinting(view)
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
  editor_mode,
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

:deep(.cm-tooltip-autocomplete) {
  @apply p-1;
}

:deep(.cm-tooltip-autocomplete > ul > li) {
  @apply flex items-center gap-1.5 rounded-sm px-2 py-1 transition-colors;
}

:deep(.cm-tooltip-autocomplete > ul > li:not([aria-selected]):hover) {
  @apply bg-slate-100 dark:bg-slate-700/60;
}

:deep(.cm-tooltip-autocomplete > ul > li[aria-selected]) {
  @apply bg-primary dark:bg-primary-700 text-white dark:text-white;
}

:deep(.cm-completionMatchedText) {
  @apply font-bold text-white/50 no-underline;
}

:deep(.cm-completionDetail) {
  @apply ml-2 text-xs not-italic text-white/50;
}

/* Custom completion types render a lucide icon via addToOptions; hide the
   default glyph so only our icon shows. */
:deep(.cm-completionIcon-story),
:deep(.cm-completionIcon-file),
:deep(.cm-completionIcon-image),
:deep(.cm-completionIcon-keyword) {
  display: none;
}

:deep(.completion-type-icon) {
  @apply h-4 w-4 shrink-0 text-white/50;
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
