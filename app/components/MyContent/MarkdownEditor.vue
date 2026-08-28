<template>
  <!-- Teleported to body in fullscreen so fixed positioning is immune to any
       transformed/filtered ancestor. Scoped styles still apply (data attrs). -->
  <Teleport to="body" :disabled="! fullscreen">
    <!-- Inline var (not scoped CSS): the teleported overlay sits at body level
         and must not pick up the app header height for preview pinning. -->
    <div
      :class="fullscreen ? 'editor-fullscreen fixed inset-0 z-[60] flex flex-col gap-2 bg-white p-3 dark:bg-slate-900' : 'flex flex-col gap-2'"
      :style="fullscreen ? { '--app-header-height': '0px' } : undefined"
    >
      <!-- Preload the lucide icons used as completion-type icons so the
         injected `iconify` spans in the autocomplete list render. -->
      <div class="hidden" aria-hidden="true">
        <MyIcon v-for="icon in completion_icon_names" :key="icon" :name="icon" />
      </div>

      <div class="flex flex-wrap items-center justify-between gap-2">
        <slot name="toolbar-start" />
        <div class="flex items-center gap-3">
          <SelectButton
            v-if="! fullscreen"
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
          <Button
            text
            severity="secondary"
            :aria-label="fullscreen ? '退出全屏' : '全屏编辑'"
            @click="toggle_fullscreen"
          >
            <template #icon>
              <MyIcon :name="fullscreen ? 'lucide:minimize' : 'lucide:maximize'" />
            </template>
          </Button>
        </div>
      </div>

      <div :class="fullscreen ? 'flex min-h-0 flex-1 gap-2' : 'flex flex-col gap-2'">
        <div
          v-if="fullscreen"
          ref="attachments_pane"
          class="shrink-0 overflow-hidden rounded-sm border border-slate-200 dark:border-slate-700"
          :style="{ width: `${attachments_width}px` }"
        >
          <!-- Inner scroller: the scrollbar ends stay inside the pane's
               rounded corners (a scrollbar isn't clipped by border-radius). -->
          <div class="h-full overflow-y-auto p-2">
            <slot name="attachments" />
          </div>
        </div>

        <div
          v-if="fullscreen"
          class="w-1.5 shrink-0 cursor-col-resize self-stretch rounded-full bg-slate-200 transition-colors hover:bg-brand-400 dark:bg-slate-700 dark:hover:bg-brand-600"
          role="separator"
          aria-orientation="vertical"
          @mousedown.prevent="start_attachments_divider_drag"
        />

        <div
          v-show="fullscreen || editor_mode === 'edit'"
          class="overflow-hidden rounded-sm border border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900"
          :class="{
            'border-dashed border-brand-400 dark:border-brand-600': drag_over,
            'editor-mode-enter': ! fullscreen && mode_has_switched && editor_mode === 'edit',
            'flex min-w-0 flex-col': fullscreen,
          }"
          :style="fullscreen ? { flex: `${split_ratio} 1 0%` } : undefined"
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
            :class="[{ hidden: ! editor_ready }, { 'flex min-h-0 flex-1 flex-col': fullscreen }]"
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
          v-if="fullscreen"
          class="w-1.5 shrink-0 cursor-col-resize self-stretch rounded-full bg-slate-200 transition-colors hover:bg-brand-400 dark:bg-slate-700 dark:hover:bg-brand-600"
          role="separator"
          aria-orientation="vertical"
          @mousedown.prevent="start_divider_drag"
        />

        <div
          v-show="fullscreen || editor_mode === 'preview'"
          ref="preview_pane"
          :class="[
            fullscreen ? 'min-w-0 overflow-y-auto rounded-sm border border-slate-200 px-3 pb-3 dark:border-slate-700' : 'section-card-collapse',
            { 'editor-mode-enter': ! fullscreen && mode_has_switched && editor_mode === 'preview' },
          ]"
          :style="fullscreen ? { flex: `${1 - split_ratio} 1 0%` } : undefined"
        >
          <MyContentMarkdownPreview :markdown="model" :story-id="storyId" :attachments="attachments" :stories="stories" empty-text="暂无可预览内容" />
        </div>
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
  </Teleport>
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
import { indentWithTab } from '@codemirror/commands'
import { html as html_lang } from '@codemirror/lang-html'
import { markdown as markdown_lang, markdownLanguage } from '@codemirror/lang-markdown'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { forceLinting, linter, lintGutter } from '@codemirror/lint'
import { Compartment, EditorSelection, EditorState, Prec, StateEffect, StateField } from '@codemirror/state'
import { Decoration, EditorView, keymap, MatchDecorator, scrollPastEnd, ViewPlugin } from '@codemirror/view'
import { tags } from '@lezer/highlight'
import { front_matter_line_count, parse_story_markdown } from '@shared/content-markdown'
import { build_html_diagnostics } from '@shared/html-lint'
import { content_rating_tiers, pinned_label, rating_label, story_rating } from '@shared/types/content'
import { basicSetup } from 'codemirror'
import { lint as markdownlint } from 'markdownlint/sync'
import { content_attachment_markdown, get_content_attachment_drag_data } from '~/utils/content/attachment-drag'
import { html_markdown_wrapper_tags } from '~/utils/content/html'

interface LintListItem {
  from: number
  line: number
  severity: Diagnostic['severity']
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

let view: EditorView | null = null
const theme_compartment = new Compartment()
const overscroll_compartment = new Compartment()

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

// Fullscreen split view: attachments pane | editor | draggable divider | preview.
const fullscreen = ref(false)
const split_ratio = ref(0.5)
const attachments_width = ref(256)
const attachments_pane = ref<HTMLElement>()
const preview_pane = ref<HTMLElement>()

function toggle_fullscreen() {
  fullscreen.value = ! fullscreen.value
}

function start_attachments_divider_drag(event: MouseEvent) {
  const start_x = event.clientX
  const start_width = attachments_width.value
  const on_move = (move: MouseEvent) => {
    attachments_width.value = Math.min(384, Math.max(160, start_width + move.clientX - start_x))
  }
  const on_up = () => {
    window.removeEventListener('mousemove', on_move)
    window.removeEventListener('mouseup', on_up)
  }
  window.addEventListener('mousemove', on_move)
  window.addEventListener('mouseup', on_up)
}

function start_divider_drag(event: MouseEvent) {
  const container = (event.currentTarget as HTMLElement).parentElement
  if (! container) {
    return
  }
  const container_rect = container.getBoundingClientRect()
  const pane_right = attachments_pane.value?.getBoundingClientRect().right ?? container_rect.left
  const available = container_rect.right - pane_right
  if (available <= 0) {
    return
  }
  const on_move = (move: MouseEvent) => {
    split_ratio.value = Math.min(0.8, Math.max(0.2, (move.clientX - pane_right) / available))
  }
  const on_up = () => {
    window.removeEventListener('mousemove', on_move)
    window.removeEventListener('mouseup', on_up)
  }
  window.addEventListener('mousemove', on_move)
  window.addEventListener('mouseup', on_up)
}

// VSCode-style scroll sync: preview blocks carry data-line anchors (their
// body line), and both directions interpolate between the anchors bracketing
// the scroll position instead of mapping raw scroll ratios.
interface ScrollAnchor {
  /** Editor-document line (0-based, front matter offset applied). */
  line: number
  /** Document-space y inside the preview pane. */
  y: number
}

function collect_scroll_anchors(): ScrollAnchor[] {
  const pane = preview_pane.value
  if (! pane) {
    return []
  }
  const line_offset = front_matter_line_count(model.value)
  const pane_top = pane.getBoundingClientRect().top
  const scroll_top = pane.scrollTop
  // Virtual start anchor: the front matter renders nothing in the preview,
  // so without a (line 0, y 0) anchor both directions clamp at the first body
  // element — the editor's front matter scroll sticks the preview, and the
  // preview's scroll-to-top maps to the first body line instead of line 0.
  const anchors: ScrollAnchor[] = [{ line: 0, y: 0 }]
  // A pinned sticky heading reports its pinned position, which tracks the
  // scroll offset itself and corrupts the anchor order — suspend stickiness
  // while measuring. The synchronous block never paints the static state.
  const body = pane.querySelector('.story-body')
  body?.classList.add('measuring')
  try {
    for (const element of pane.querySelectorAll<HTMLElement>('[data-line]')) {
      const line = Number(element.dataset.line)
      if (! Number.isFinite(line)) {
        continue
      }
      anchors.push({ line: line + line_offset, y: element.getBoundingClientRect().top - pane_top + scroll_top })
    }
  }
  finally {
    body?.classList.remove('measuring')
  }
  anchors.sort((a, b) => a.line - b.line || a.y - b.y)
  return anchors
}

/** Map one anchor axis to the other, interpolating between bracketing anchors. */
function interpolate_anchors(anchors: ScrollAnchor[], key: 'line' | 'y', value: number) {
  const other = key === 'line' ? 'y' : 'line'
  const first = anchors[0]!
  const last = anchors[anchors.length - 1]!
  if (value <= first[key]) {
    return first[other]
  }
  if (value >= last[key]) {
    return last[other]
  }
  for (let i = 1; i < anchors.length; i ++) {
    const next = anchors[i]!
    if (next[key] >= value) {
      const prev = anchors[i - 1]!
      const span = next[key] - prev[key]
      if (span <= 0) {
        return prev[other]
      }
      return prev[other] + ((value - prev[key]) / span) * (next[other] - prev[other])
    }
  }
  return last[other]
}

/** Fractional 0-based line at the top of the editor viewport. */
function editor_top_line() {
  if (! view) {
    return null
  }
  // Document-space math only: posAtCoords/coordsAtPos mix in CodeMirror's
  // cached scroll position, which lags behind programmatic scrollTop writes
  // (CM re-measures on rAF) and breaks the mapping while syncing.
  const doc_height = view.scrollDOM.getBoundingClientRect().top - view.documentTop
  const block = view.lineBlockAtHeight(doc_height)
  const line = view.state.doc.lineAt(block.from).number - 1
  const ratio = block.height > 0
    ? Math.min(Math.max((doc_height - block.top) / block.height, 0), 1)
    : 0
  return line + ratio
}

/** Scroll the editor so the fractional 0-based line sits at the viewport top. */
function scroll_editor_to_line(fractional_line: number) {
  if (! view) {
    return
  }
  const doc = view.state.doc
  const line_index = Math.min(Math.max(Math.floor(fractional_line), 0), doc.lines - 1)
  const block = view.lineBlockAt(doc.line(line_index + 1).from)
  const scroller = view.scrollDOM
  scroller.scrollTop = scroller.scrollTop
    + (view.documentTop + block.top - scroller.getBoundingClientRect().top)
    + (fractional_line - line_index) * block.height
}

// Echo detection breaks the scroll-event feedback loop without rAF timing
// races: a scroll event landing (within rounding) on the target we just set
// programmatically is our own echo, not user input.
let expected_editor_scroll: number | null = null
let expected_preview_scroll: number | null = null

function on_editor_scrolled() {
  if (! view || ! preview_pane.value) {
    return
  }
  if (expected_editor_scroll !== null) {
    const echo = Math.abs(view.scrollDOM.scrollTop - expected_editor_scroll) < 2
    expected_editor_scroll = null
    if (echo) {
      return
    }
  }
  const line = editor_top_line()
  const anchors = collect_scroll_anchors()
  if (line === null || ! anchors.length) {
    return
  }
  preview_pane.value.scrollTop = interpolate_anchors(anchors, 'line', line)
  expected_preview_scroll = preview_pane.value.scrollTop
}

function on_preview_scrolled() {
  if (! view || ! preview_pane.value) {
    return
  }
  if (expected_preview_scroll !== null) {
    const echo = Math.abs(preview_pane.value.scrollTop - expected_preview_scroll) < 2
    expected_preview_scroll = null
    if (echo) {
      return
    }
  }
  const anchors = collect_scroll_anchors()
  if (! anchors.length) {
    return
  }
  scroll_editor_to_line(interpolate_anchors(anchors, 'y', preview_pane.value.scrollTop))
  expected_editor_scroll = view.scrollDOM.scrollTop
}

function on_fullscreen_keydown(event: KeyboardEvent) {
  // defaultPrevented means the editor consumed the key (e.g. closing search).
  if (event.key === 'Escape' && ! event.defaultPrevented) {
    fullscreen.value = false
  }
}

watch(fullscreen, async (active) => {
  document.documentElement.style.overflow = active ? 'hidden' : ''
  // Overscroll (editor: past-end padding, preview: CSS bottom padding) lets
  // both sides reach the sync target near the end of the document.
  view?.dispatch({ effects: overscroll_compartment.reconfigure(active ? scrollPastEnd() : []) })
  if (active) {
    window.addEventListener('keydown', on_fullscreen_keydown)
    await nextTick()
    view?.scrollDOM.addEventListener('scroll', on_editor_scrolled, { passive: true })
    preview_pane.value?.addEventListener('scroll', on_preview_scrolled, { passive: true })
  }
  else {
    expected_editor_scroll = null
    expected_preview_scroll = null
    window.removeEventListener('keydown', on_fullscreen_keydown)
    view?.scrollDOM.removeEventListener('scroll', on_editor_scrolled)
    preview_pane.value?.removeEventListener('scroll', on_preview_scrolled)
  }
  // The editor's box changed shape; CodeMirror must re-measure.
  view?.requestMeasure()
})

const search_open = ref(false)
const search_query = ref('')
const replace_query = ref('')
const match_case = ref(false)
const match_regexp = ref(false)
const match_word = ref(false)
const match_count = ref(0)
const match_active = ref(- 1)
const search_input = ref<{ $el: HTMLInputElement } | null>(null)

const markdownlint_config: MarkdownlintConfiguration = {
  default: 'error',
  MD012: false,
  MD013: false,
  MD025: false,
  MD026: false,
  MD028: false,
  MD033: false,
  MD040: false,
  MD045: false,
  MD060: false,
}
const front_matter_pattern = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/

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
    severity: diagnostic.severity,
    message: diagnostic.message,
    source: diagnostic.source ?? null,
  }))
}

const initial_doc = EditorState.create({ doc: model.value }).doc
issues.value = diagnostics_to_items(build_diagnostics(model.value, initial_doc), initial_doc)

// Dispatched on an otherwise-no-op transaction when `props.stories` changes so
// the lint plugin re-schedules a run (its `force()` is a no-op while idle).
const stories_changed_effect = StateEffect.define<null>()

const lint_source = linter((editor_view) => {
  const diagnostics = build_diagnostics(editor_view.state.doc.toString(), editor_view.state.doc)

  if (view) {
    const items = diagnostics_to_items(diagnostics, editor_view.state.doc)
    issues.value = items
    emit('lint', items)
  }

  return diagnostics
}, {
  delay: 400,
  needsRefresh: update => update.transactions.some(tr => tr.effects.some(effect => effect.is(stories_changed_effect))),
})

// `@` story completion: `[](@query` completes to `[](@title)`, a bare `@query`
// to a wrapped `[](@title)`. The token charset mirrors the shared reference
// regex (`[^)\s<>]`): titles may contain CJK punctuation like `，`, so the
// token must not be restricted to word characters.
const story_at_patterns = {
  link: /\((@[^)\s<>]*)$/u,
  bare: /(?:^|[\s(])(@[^)\s<>]*)$/u,
}
const story_at_valid = /^@[^)\s<>]*$/u

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

// lezer-markdown's built-in HTMLBlock looks for the blank line that ends a
// type-6 block in the RAW line text, so inside a blockquote a `>`-only line
// never ends the block and the html language swallows the rest of the quote,
// killing markdown highlight after e.g. `<hr />`. This replacement is the same
// parser except the blank-line test runs on the content after container
// markers. Styles mirror @lezer/markdown's HTMLBlockStyle table.
const html_empty_line = /^[ \t]*$/
const html_comment_end = /-->/
const html_processing_end = /\?>/
const html_block_style: [RegExp, RegExp][] = [
  [/^<(?:script|pre|style)(?:\s|>|$)/i, /<\/(?:script|pre|style)>/i],
  [/^\s*<!--/, html_comment_end],
  [/^\s*<\?/, html_processing_end],
  [/^\s*<![A-Z]/, />/],
  [/^\s*<!\[CDATA\[/, /\]\]>/],
  [/^\s*<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h1|h2|h3|h4|h5|h6|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|section|source|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?:\s|\/?>|$)/i, html_empty_line],
  [/^\s*(?:<\/[a-z][\w-]*\s*>|<[a-z][\w-]*(\s+[a-z:_][-\w.]*(?:\s*=\s*(?:[^\s"'=<>`]+|'[^']*'|"[^"]*"))?)*\s*>)\s*$/i, html_empty_line],
]

type MarkdownExtensionConfig = Exclude<NonNullable<NonNullable<Parameters<typeof markdown_lang>[0]>['extensions']>, readonly unknown[]>

const container_aware_html_block: MarkdownExtensionConfig = {
  parseBlock: [{
    name: 'ContainerAwareHTMLBlock',
    before: 'HTMLBlock',
    parse(cx, line) {
      let type = - 1
      if (line.text.charCodeAt(line.pos) === 60) // '<'
        type = html_block_style.findIndex(([start]) => start.test(line.text.slice(line.pos)))
      if (type < 0)
        return false
      const from = cx.lineStart + line.pos
      const end = html_block_style[type]![1]
      const at_end = () => end === html_empty_line
        ? html_empty_line.test(line.text.slice(line.pos))
        : end.test(line.text)
      const marks: typeof line.markers = []
      let trailing = end !== html_empty_line
      while (! at_end()) {
        if (! cx.nextLine())
          break
        // Line.depth is internal (untyped) but is the only container-exit signal.
        if ((line as typeof line & { depth: number }).depth < cx.depth) {
          trailing = false
          break
        }
        // The terminating blank line belongs to the container, not the block.
        if (end === html_empty_line && at_end())
          break
        for (const mark of line.markers)
          marks.push(mark)
      }
      if (trailing)
        cx.nextLine()
      const node_name = end === html_comment_end ? 'CommentBlock' : end === html_processing_end ? 'ProcessingInstructionBlock' : 'HTMLBlock'
      cx.addElement(cx.elt(node_name, from, cx.prevLineEnd(), marks))
      return true
    },
  }],
}

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

// Markdown nested inside HTML elements must not treat indented HTML (e.g. the
// `<td>` cells of a table) as indented code blocks, which would stop the
// nested highlight recursion — so this parser drops IndentedCode.
const editor_nested_markdown_lang = markdown_lang({
  extensions: [container_aware_html_block, { remove: ['SetextHeading', 'IndentedCode'] }],
  htmlTagLanguage: editor_html_lang,
})

for (const entry of markdown_inside_html_tags) {
  entry.parser = editor_nested_markdown_lang.language.parser
}

// The top-level editor markdown keeps IndentedCode (real code blocks at the
// document level), sharing the same html language so HTML it contains re-nests
// into the nested markdown parser above.
const editor_markdown_lang = markdown_lang({
  extensions: [container_aware_html_block, { remove: ['SetextHeading'] }],
  htmlTagLanguage: editor_html_lang,
})

// closeBrackets (from basicSetup) reads this language data: backtick joins the
// default pairs, so a selection wraps in `...` and an empty cursor auto-closes.
// Registered globally so it also reaches HTML regions nested in the markdown.
const editor_close_brackets = EditorState.languageData.of(() =>
  [{ closeBrackets: { brackets: ['(', '[', '{', '\'', '"', '`'] } }])

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
    // The `u` flag enables Unicode property escapes (`\p{Emoji}`, ...).
    return new RegExp(source, spec.case_sensitive ? 'gu' : 'giu')
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
    return matched.replace(new RegExp(`^(?:${source})$`, spec.case_sensitive ? 'u' : 'iu'), replace_query.value)
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
        keymap.of([indentWithTab]),
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
        editor_close_brackets,
        lint_source,
        lintGutter(),
        autocomplete_ext,
        search_field,
        alert_marker_plugin,
        theme_compartment.of(theme_extensions(color_mode.value)),
        overscroll_compartment.of([]),
        EditorView.lineWrapping,
        // Ctrl+V of an image/file uploads it as an attachment (the parent
        // handles the upload) and inserts the reference at the cursor.
        EditorView.domEventHandlers({
          paste: (event, editor_view) => {
            const files = event.clipboardData?.files ? [... event.clipboardData.files] : []
            if (! files.length) {
              return false
            }
            event.preventDefault()
            emit('files-dropped', files, editor_view.state.selection.main.from)
            return true
          },
        }),
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
  document.documentElement.style.overflow = ''
  window.removeEventListener('keydown', on_fullscreen_keydown)
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
  // `forceLinting` alone is a no-op while the linter is idle, so first mark the
  // linter dirty via `needsRefresh` (a doc-change-free transaction), then force it.
  if (view) {
    view.dispatch({ effects: stories_changed_effect.of(null) })
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
  // Synchronous copy of the full combined lint (front matter + HTML grammar +
  // markdownlint) on the current doc, so save can block on the same errors the
  // editor displays without waiting for the debounced lint pass.
  validate() {
    if (! view) {
      return [] as LintListItem[]
    }
    const doc = view.state.doc
    return diagnostics_to_items(build_diagnostics(doc.toString(), doc), doc)
  },
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

/* In fullscreen the editor pane fills the split instead of the 60vh cap. */
.editor-fullscreen :deep(.cm-editor) {
  @apply min-h-0 max-h-none;
}

/* The fullscreen attachments pane is narrow: force the card actions onto
   their own row (width:100% wraps the flex line) so the file name and size
   keep the full card width, and drop the per-card bottom margin in favor of
   the pane's gap. */
.editor-fullscreen :deep(.attachment-card) {
  @apply mb-0;
}

.editor-fullscreen :deep(.attachment-card-content) {
  @apply flex-wrap;
}

.editor-fullscreen :deep(.attachment-card-actions) {
  @apply w-full justify-end;
}

/* The frosted heading bars bleed to 100vw on the detail page; inside the
   fullscreen pane that overflows the pane horizontally, so they span only
   the content column here. */
.editor-fullscreen :deep(.story-body :is(h1, h2, h3, h4, h5, h6)) {
  margin-inline: 0;
  padding-inline: 0;
}

/* Sticky headings pin to the pane's content-box edge, so the pane itself
   keeps no top padding: the story body's own top padding scrolls away with
   the content instead of leaving a crisp strip above the pinned band. The
   bottom padding is VSCode-style overscroll so the last block can still
   scroll to the pane top for scroll sync. */
.editor-fullscreen :deep(.story-body) {
  @apply pt-3 pb-[calc(100vh-6rem)];
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
  @apply font-bold text-slate-500 no-underline dark:text-slate-400;
}

:deep(.cm-completionDetail) {
  @apply ml-2 text-xs not-italic text-slate-400 dark:text-slate-500;
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
  @apply h-4 w-4 shrink-0 text-slate-400 dark:text-slate-500 transition;
}

/* On the selected (primary) row the muted accents would vanish. */
:deep(.cm-tooltip-autocomplete > ul > li[aria-selected]) :is(.cm-completionMatchedText, .cm-completionDetail, .completion-type-icon) {
  @apply text-white/70;
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
