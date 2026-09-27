<template>
  <!-- Teleported to body in fullscreen so fixed positioning is immune to any
       transformed/filtered ancestor. Scoped styles still apply (data attrs). -->
  <Teleport to="body" :disabled="! fullscreen">
    <!-- Inline var (not scoped CSS): the teleported overlay sits at body level
         and must not pick up the app header height for preview pinning. -->
    <div
      :class="fullscreen ? 'editor-fullscreen fixed inset-0 z-[60] flex flex-col gap-2 bg-white p-3 dark:bg-slate-900' : 'flex flex-col gap-2'"
      :style="fullscreen ? { '--app-header-height': '0px' } : undefined"
      @dragover.capture="on_overlay_dragover"
      @drop.capture="on_overlay_drop"
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
            class="aspect-square"
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

      <div :class="fullscreen ? 'flex min-h-0 flex-1' : 'flex flex-col gap-2'">
        <div
          v-if="fullscreen"
          class="editor-attachments-pane shrink-0 overflow-hidden rounded-l-sm border border-r-0 border-slate-200 dark:border-slate-700"
          :style="{ width: `${attachments_width}px` }"
        >
          <!-- Inner scroller: the scrollbar ends stay inside the pane's
               rounded corners (a scrollbar isn't clipped by border-radius).
               Side padding lives on the list root instead, so the gutter
               belongs to the list's marquee trigger area. -->
          <div class="h-full overflow-y-auto py-2">
            <slot name="attachments" />
          </div>
        </div>

        <div
          v-if="fullscreen"
          class="editor-divider"
          role="separator"
          aria-orientation="vertical"
          @mousedown.prevent="start_attachments_divider_drag"
        />

        <div
          v-show="fullscreen || editor_mode === 'edit'"
          ref="text_pane"
          class="editor-text-pane overflow-hidden rounded-sm border border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900"
          :class="{
            'border-dashed border-brand-400 dark:border-brand-600': drag_over,
            'editor-mode-enter': ! fullscreen && mode_has_switched && editor_mode === 'edit',
            'flex min-w-0 flex-col': fullscreen,
            'border-x-0 rounded-l-none rounded-r-none': fullscreen,
          }"
          :style="fullscreen ? { flex: `${split_ratio} 1 0%` } : undefined"
          @dragenter.capture.prevent="on_drag_over"
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

          <MyContentMarkdownEditorSearchPanel v-if="search.open" :search="search" />
        </div>

        <div
          v-if="fullscreen"
          class="editor-divider"
          role="separator"
          aria-orientation="vertical"
          @mousedown.prevent="start_divider_drag"
        />

        <div
          v-show="fullscreen || editor_mode === 'preview'"
          ref="preview_pane"
          :class="[
            fullscreen ? 'min-w-0 overflow-y-auto rounded-r-sm border border-l-0 border-slate-200 px-3 pb-3 dark:border-slate-700' : 'section-card-collapse',
            { 'editor-mode-enter': ! fullscreen && mode_has_switched && editor_mode === 'preview' },
          ]"
          :style="fullscreen ? { flex: `${1 - split_ratio} 1 0%` } : undefined"
        >
          <MyContentMarkdownPreview :markdown="model" :story-id="storyId" :attachments="attachments" :stories="stories" empty-text="暂无可预览内容" @folder-open="emit('folder-open', $event)" />
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
import type { ContentStoryAttachment, ContentStorySummary } from '@shared/types/content'
import type { AttachmentUploadPick } from '~/utils/content/attachment'
import type { LintListItem } from '~/utils/content/editor/lint'
import { startCompletion } from '@codemirror/autocomplete'
import { indentWithTab } from '@codemirror/commands'
import { lintGutter } from '@codemirror/lint'
import { Compartment, EditorState, Prec } from '@codemirror/state'
import { EditorView, keymap, scrollPastEnd } from '@codemirror/view'
import { front_matter_line_count } from '@shared/content-markdown'
import { basicSetup } from 'codemirror'
import { attachment_pick_from_file, attachment_picks_from_data_transfer } from '~/utils/content/attachment'
import { content_attachment_drag_type, content_attachment_markdown, content_folder_drag_type, content_folder_markdown, get_content_attachment_drag_data, get_content_folder_drag_data } from '~/utils/content/attachment-drag'
import { alert_marker_plugin } from '~/utils/content/editor/alert-marker'
import { completion_icon_names, create_completion_extensions } from '~/utils/content/editor/completions'
import { editor_close_brackets, editor_markdown_lang } from '~/utils/content/editor/language'
import { build_diagnostics, create_markdown_lint, diagnostics_to_items, refresh_markdown_lint, story_lint_config } from '~/utils/content/editor/lint'
import { search_field } from '~/utils/content/editor/search'
import { theme_extensions } from '~/utils/content/editor/themes'

const props = withDefaults(defineProps<{
  storyId?: number | null
  attachments?: ContentStoryAttachment[]
  placeholder?: string
  /** Known stories for `@story` completion, dead-reference linting and preview cards. */
  stories?: ContentStorySummary[]
  /** Folder paths in scope, offered alongside the attachments in the destination completion. */
  folders?: string[]
}>(), {
  storyId: null,
  attachments: () => [],
  placeholder: '',
  stories: () => [],
  folders: () => [],
})

const emit = defineEmits<{
  'lint': [issues: LintListItem[]]
  'files-dropped': [files: AttachmentUploadPick[], position: number | null]
  /** Clipboard files; kept apart from drops so the parent can ask for a name. */
  'files-pasted': [files: AttachmentUploadPick[], position: number | null]
  'attachment-drop-outside': [event: DragEvent]
  /** A folder card in the preview was activated. */
  'folder-open': [folder: string]
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
const text_pane = ref<HTMLElement>()
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

/**
 * Editor/preview divider. Both panes are flex-sized (`flex: <ratio> 1 0%`), so
 * their widths are the ratio's shares of their combined width — which stays put
 * for the whole drag (what one pane gains the other loses) and is measured here
 * rather than derived from the row, keeping the dividers' own widths out of the
 * mapping. The pointer's travel is applied as a delta for the same reason the
 * attachments divider uses one: the divider follows the cursor 1:1 from wherever
 * it was grabbed, instead of snapping to an absolute position on the first move.
 */
function start_divider_drag(event: MouseEvent) {
  const editor = text_pane.value
  const preview = preview_pane.value
  if (! editor || ! preview) {
    return
  }
  const free = editor.getBoundingClientRect().width + preview.getBoundingClientRect().width
  if (free <= 0) {
    return
  }
  const start_x = event.clientX
  const start_ratio = split_ratio.value
  const on_move = (move: MouseEvent) => {
    split_ratio.value = Math.min(0.8, Math.max(0.2, start_ratio + (move.clientX - start_x) / free))
  }
  const on_up = () => {
    window.removeEventListener('mousemove', on_move)
    window.removeEventListener('mouseup', on_up)
  }
  window.addEventListener('mousemove', on_move)
  window.addEventListener('mouseup', on_up)
}

// VSCode-style editor <-> preview scroll sync lives in the composable;
// attach/detach are driven by the fullscreen watcher below.
const scroll_sync = useMarkdownEditorScrollSync(() => view, preview_pane, () => front_matter_line_count(model.value))

watch(fullscreen, async (active) => {
  document.documentElement.style.overflow = active ? 'hidden' : ''
  // Overscroll (editor: past-end padding, preview: dynamic bottom padding set
  // by the scroll sync) lets both sides reach the sync target near the end of
  // the document.
  view?.dispatch({ effects: overscroll_compartment.reconfigure(active ? scrollPastEnd() : []) })
  if (active) {
    await nextTick()
    scroll_sync.attach()
  }
  else {
    scroll_sync.detach()
  }
  // The editor's box changed shape; CodeMirror must re-measure.
  view?.requestMeasure()
})

const search = useMarkdownSearch(() => view)

const get_lint_config = () => story_lint_config(public_config, props.stories, props.storyId)

const lint_source = create_markdown_lint(get_lint_config, (items) => {
  if (! view) {
    return
  }
  issues.value = items
  emit('lint', items)
})

const initial_doc = EditorState.create({ doc: model.value }).doc
issues.value = diagnostics_to_items(build_diagnostics(model.value, initial_doc, get_lint_config()), initial_doc)

const autocomplete_ext = create_completion_extensions({
  stories: () => props.stories,
  story_id: () => props.storyId,
  attachments: () => props.attachments,
  folders: () => props.folders,
})

watch(editor_mode, (mode) => {
  mode_has_switched.value = true
  if (mode !== 'edit')
    search.close_search()
})

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
              search.open_search()
              return true
            },
          },
          {
            key: 'Escape',
            run: () => {
              if (! search.open)
                return false
              search.close_search()
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
            emit('files-pasted', files.map(attachment_pick_from_file), editor_view.state.selection.main.from)
            return true
          },
        }),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            model.value = update.state.doc.toString()
          }
          search.on_editor_update(update)
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
    refresh_markdown_lint(view)
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
    return diagnostics_to_items(build_diagnostics(doc.toString(), doc, get_lint_config()), doc)
  },
})

async function on_drop(event: DragEvent) {
  drag_over.value = false
  const picks = await attachment_picks_from_data_transfer(event.dataTransfer)
  if (picks.length) {
    const position = view ? (view.posAtCoords({ x: event.clientX, y: event.clientY }) ?? view.state.selection.main.from) : null
    emit('files-dropped', picks, position)
    return
  }

  const attachment = get_content_attachment_drag_data(event.dataTransfer)
  if (attachment && view) {
    const position = view.posAtCoords({ x: event.clientX, y: event.clientY }) ?? view.state.selection.main.from
    insert_at_position(content_attachment_markdown(attachment), position)
    return
  }

  // A dragged folder inserts its link shorthand, the same form the folder card
  // copy action produces: the preview renders it as a card.
  const folder = get_content_folder_drag_data(event.dataTransfer)
  if (folder && view) {
    const position = view.posAtCoords({ x: event.clientX, y: event.clientY }) ?? view.state.selection.main.from
    insert_at_position(content_folder_markdown(folder.folder), position)
  }
}

// Bound to dragenter (capture) and dragover (bubble), and the phases differ on
// purpose:
// - A drop effect is only honoured for a dragover preceded by an accepted
//   dragenter. Without a dragenter handler, crossing between elements (the gaps
//   between .cm-line boxes, or the gutter/content boundary) leaves a brief
//   unacknowledged window after each dragenter, in which the OS shows the
//   "no drop" cursor; crossing such a boundary repeatedly makes it flicker.
//   CodeMirror registers no dragenter observer, so preventing it in the capture
//   phase costs nothing.
// - dragover must stay in the bubble phase. CodeMirror listens on contentDOM and
//   bails out of every handler and observer once the event is already
//   defaultPrevented, so preventing it from an ancestor's capture phase stops
//   its drop-cursor plugin from running and the insertion line disappears.
//   Bubbling means the deeper contentDOM handler runs first, then this one.
function on_drag_over(event: DragEvent) {
  drag_over.value = true
  if (event.dataTransfer) {
    event.dataTransfer.dropEffect = 'copy'
  }
}

// In fullscreen the overlay owns every drag the panes don't claim (preview,
// dividers, toolbar, gaps), so an attachment/folder drag never shows the OS
// "banned" cursor there; dropping moves the dragged items back to the root.
// The editor text pane and the attachments pane fully own their own drag
// handling (including deliberately "banned" no-op targets inside the list).
function is_internal_attachment_drag(event: DragEvent) {
  const types = event.dataTransfer?.types
  return !! types && (types.includes(content_attachment_drag_type) || types.includes(content_folder_drag_type))
}

function is_owned_dropzone(event: DragEvent) {
  return !! (event.target as HTMLElement | null)?.closest('.editor-text-pane, .editor-attachments-pane')
}

function on_overlay_dragover(event: DragEvent) {
  if (! fullscreen.value || ! is_internal_attachment_drag(event))
    return
  // Stay out of the panes, the same way on_overlay_drop does. Both run for every
  // dragover, and the browser resets dropEffect per event, so a second writer
  // here fights the pane's own handler: whichever ran last won, and the result
  // swung with the element under the pointer. Over the attachment list that
  // brought back the flicker its constant 'move' cursor exists to prevent; over
  // the editor it replaced the insert cursor the pane sets.
  if (is_owned_dropzone(event))
    return
  event.preventDefault()
  if (event.dataTransfer)
    event.dataTransfer.dropEffect = 'move'
}

function on_overlay_drop(event: DragEvent) {
  if (! fullscreen.value || ! is_internal_attachment_drag(event) || is_owned_dropzone(event))
    return
  event.preventDefault()
  emit('attachment-drop-outside', event)
}
</script>

<style scoped>
/* The split's separator is the seam itself: the same colour the panes use for
   their borders, between panes that keep no border there (border-x-0 /
   border-r-0 / border-l-0) and square off the corners facing it — so the three
   panes read as one plate divided by two bands, with rounding only on the
   outside. A 7px transparent strip still takes the drag, centred on the band
   but wider than it, so the cursor doesn't have to land on the few visible
   pixels. */
.editor-divider {
  @apply relative w-1 shrink-0 cursor-col-resize self-stretch bg-slate-200 transition-colors hover:bg-brand-400 dark:bg-slate-700 dark:hover:bg-brand-600;
}

.editor-divider::before {
  content: '';
  @apply absolute inset-y-0;
  inset-inline: -3px;
}

:deep(.cm-editor) {
  @apply min-h-80 max-h-[60vh] text-sm;
}

/* In fullscreen the editor pane fills the split instead of the 60vh cap. */
.editor-fullscreen :deep(.cm-editor) {
  @apply min-h-0 max-h-none;
}

/* The frosted heading bars bleed to 100vw on the detail page; inside the
   fullscreen pane that would overflow horizontally, so they bleed only into
   the pane's px-3 padding (edge-to-edge, scrollbar excluded) with the
   padding keeping the title text on the content column. */
.editor-fullscreen :deep(.story-body :is(h1, h2, h3, h4, h5, h6)) {
  margin-inline: -0.75rem;
  padding-inline: 0.75rem;
}

/* Sticky headings pin to the pane's content-box edge, so the pane itself
   keeps no top padding: the story body's own top padding scrolls away with
   the content instead of leaving a crisp strip above the pinned band. The
   bottom overscroll padding (so the last block can scroll to the pane top
   for scroll sync) is set dynamically by useEditorScrollSync — a static
   calc(100vh - ...) can't match the real pane height. */
.editor-fullscreen :deep(.story-body) {
  @apply pt-3;
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

/* Every option carries the lucide icon our renderer injects (the library's own
   glyph is off via `icons: false`), in a fixed-width column so the labels line
   up whatever the type. */
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
