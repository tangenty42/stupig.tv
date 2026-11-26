<template>
  <!-- Teleported to body in fullscreen so fixed positioning is immune to any
       transformed/filtered ancestor. Scoped styles still apply (data attrs). -->
  <Teleport to="body" :disabled="! fullscreen">
    <!-- Inline var (not scoped CSS): the teleported overlay sits at body level
         and must not pick up the app header height for preview pinning. -->
    <div
      ref="editor_surface"
      :class="fullscreen ? 'editor-fullscreen fixed inset-0 z-[60] flex flex-col gap-2 bg-white p-3 dark:bg-slate-900' : 'flex flex-col gap-2'"
      :style="fullscreen ? { '--app-header-height': '0px' } : undefined"
      @dragover.capture="on_overlay_dragover"
      @drop.capture="on_overlay_drop"
    >
      <MyContentAttachmentMarkdownChoice :visible="markdown_pending" @choose="confirm_markdown" @cancel="cancel_markdown" />
      <!-- Preload the lucide icons used as completion-type icons so the
         injected `iconify` spans in the autocomplete list render. -->
      <div class="hidden" aria-hidden="true">
        <MyIcon v-for="icon in completion_icon_names" :key="icon" :name="icon" />
      </div>

      <div class="flex flex-wrap items-center justify-between gap-2">
        <slot name="toolbar-start" />
        <div class="flex items-center gap-3">
          <SelectButton
            v-model="display_mode"
            :options="visible_modes"
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
          <div class="h-full overflow-y-auto">
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
          class="editor-column flex min-h-0 min-w-0 flex-col"
          :class="fullscreen ? 'gap-0' : 'gap-2'"
          :style="fullscreen ? { flex: `${split_ratio} 1 0%` } : undefined"
        >
          <div
            ref="text_pane"
            class="editor-text-pane overflow-hidden rounded-sm border border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900"
            :class="{
              'border-dashed border-brand-400 dark:border-brand-600': drag_over,
              'editor-mode-enter': ! fullscreen && mode_has_switched && editor_mode === 'edit',
              'flex min-h-0 min-w-0 flex-1 flex-col': fullscreen,
              'border-x-0 rounded-l-none rounded-r-none': fullscreen,
            }"
            @dragenter.capture.prevent="on_drag_over"
            @dragover.prevent="on_drag_over"
            @dragleave.prevent="drag_over = false"
            @drop.prevent="on_drop"
          >
            <div
              v-if="! editor_ready"
              class="flex min-h-80 max-h-[60vh] items-center justify-center text-sm text-slate-400 dark:text-slate-500"
            >
              代码编辑器加载中……
            </div>
            <div
              ref="editor_host"
              :class="[{ hidden: ! editor_ready }, { 'flex min-h-0 flex-1 flex-col': fullscreen }]"
            />

            <MyContentMarkdownEditorSearchPanel v-if="search.open" :search="search" :readonly="readonly" />
          </div>

          <div
            v-if="(fullscreen || editor_mode === 'edit') && issues.length"
            class="editor-issues shrink-0 border border-slate-200 bg-slate-50 dark:border-slate-700 dark:bg-slate-800/50 overflow-hidden"
            :class="fullscreen ? 'rounded-none border-x-0 border-t-0' : 'rounded-sm'"
          >
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
          <slot name="diagnostics" />
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
          :class="[
            fullscreen ? 'min-h-0 min-w-0 overflow-hidden rounded-r-sm border border-l-0 border-slate-200 dark:border-slate-700' : 'section-card-collapse',
            { 'editor-mode-enter': ! fullscreen && mode_has_switched && editor_mode === 'preview' },
          ]"
          :style="fullscreen ? { flex: `${1 - split_ratio} 1 0%` } : undefined"
        >
          <div ref="preview_pane" :class="fullscreen ? 'h-full overflow-y-auto px-3 pb-3' : undefined">
            <MyContentMarkdownPreview :markdown="model" :story-id="storyId" :attachments="attachments" :folders="folders" :stories="stories" :public-view="preview_audience === 'public'" can-read-private empty-text="暂无可预览内容" />
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import type { ContentStoryAttachment, ContentStorySummary } from '@shared/types/content'
import type { CompletionSourceFailure } from '~/features/content/markdown/editor/completions'
import type { LintListItem } from '~/features/content/markdown/editor/lint'
import type { AttachmentUploadPick } from '~/features/content/uploads/picks'
import { content_attachment_drag_file_names, resolve_markdown_selection } from '~/features/content/attachments/drag'
import { content_attachment_drag_type, content_folder_drag_type, get_content_attachment_drag_data, get_content_folder_drag_data } from '~/features/content/attachments/drag-transfer'
import { useAttachmentMarkdown } from '~/features/content/attachments/markdown-action'
import { useStoryEditor } from '~/features/content/markdown/editor'
import { completion_icon_names } from '~/features/content/markdown/editor/completions'
import { useStoryEditorViewState } from '~/features/content/markdown/view-state'
import { attachment_picks_from_data_transfer } from '~/features/content/uploads/browser-picks'

const props = withDefaults(defineProps<{
  storyId?: number | null
  attachments?: ContentStoryAttachment[]
  attachmentsFailure?: CompletionSourceFailure
  placeholder?: string
  readonly?: boolean
  allowWrite?: () => boolean
  historyKey?: number
  /** Account + immutable cloud draft id; only presentation state is stored. */
  viewStateKey?: string | null
  /** Known stories for `@story` completion, dead-reference linting and preview cards. */
  stories?: ContentStorySummary[]
  storiesFailure?: CompletionSourceFailure
  /** Folder paths in scope, offered alongside the attachments in the destination completion. */
  folders?: string[]
  referencedPaths?: ReadonlySet<string> | null
}>(), {
  storyId: null,
  attachments: () => [],
  placeholder: '',
  readonly: false,
  stories: () => [],
  folders: () => [],
})

const emit = defineEmits<{
  'lint': [issues: LintListItem[]]
  'files-dropped': [files: AttachmentUploadPick[], position: number | null]
  /** Clipboard files; kept apart from drops so the parent can ask for a name. */
  'files-pasted': [files: AttachmentUploadPick[], position: number | null]
  'attachment-drop-outside': [event: DragEvent]
}>()

const model = defineModel<string>({ default: '' })

const editor_host = ref<HTMLElement>()
const drag_over = ref(false)
const editor_mode = ref<'edit' | 'preview'>('edit')
const preview_audience = ref<'private' | 'public'>('private')
const mode_has_switched = ref(false)

const editor_modes = [
  { label: '编辑', value: 'edit', icon: 'lucide:pencil' },
  { label: '天子上朝', value: 'private', icon: 'lucide:eye' },
  { label: '微服私访', value: 'public', icon: 'lucide:eye-off' },
]

// Fullscreen split view: attachments pane | editor | draggable divider | preview.
const fullscreen = ref(false)
const visible_modes = computed(() => fullscreen.value ? editor_modes.filter(mode => mode.value !== 'edit') : editor_modes)
const display_mode = computed({
  get: () => ! fullscreen.value && editor_mode.value === 'edit' ? 'edit' : preview_audience.value,
  set: (value: 'edit' | 'private' | 'public') => {
    if (value === 'edit') {
      editor_mode.value = 'edit'
    }
    else {
      preview_audience.value = value
      if (! fullscreen.value)
        editor_mode.value = 'preview'
    }
  },
})
const split_ratio = ref(0.5)
const attachments_width = ref(256)
const editor_surface = useTemplateRef<HTMLElement>('editor_surface')
const text_pane = ref<HTMLElement>()
const preview_pane = ref<HTMLElement>()
let switching_fullscreen = false
let fullscreen_transition: ViewTransition | undefined
let disposed = false
const fullscreen_animations: Animation[] = []

async function toggle_fullscreen() {
  if (switching_fullscreen)
    return
  const next = ! fullscreen.value
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    fullscreen.value = next
    return
  }

  switching_fullscreen = true
  try {
    if (typeof document.startViewTransition === 'function') {
      // Capture both layouts around the Teleport move so CodeMirror stays mounted.
      fullscreen_transition = document.startViewTransition(async () => {
        if (! disposed) {
          fullscreen.value = next
          await nextTick()
        }
      })
      void fullscreen_transition.ready.catch(() => {})
      await fullscreen_transition.finished
    }
    else {
      await fade_fullscreen(next)
    }
  }
  catch {
    if (! disposed)
      fullscreen.value = next
  }
  finally {
    fullscreen_transition = undefined
    fullscreen_animations.splice(0).forEach(animation => animation.cancel())
    switching_fullscreen = false
  }
}

async function fade_fullscreen(next: boolean) {
  const page = document.getElementById('__nuxt')
  const surface = editor_surface.value
  if (! page?.animate || ! surface?.animate) {
    fullscreen.value = next
    return
  }

  // Keep the inline page hidden while the fullscreen editor docks back into it.
  const underlay = next ? undefined : page.animate([{ opacity: 0 }, { opacity: 0 }], { fill: 'both' })
  if (underlay)
    fullscreen_animations.push(underlay)
  const leaving = (next ? page : surface).animate({ opacity: [1, 0] }, { duration: 180, easing: 'ease-in', fill: 'both' })
  fullscreen_animations.push(leaving)
  await leaving.finished
  if (disposed)
    return

  fullscreen.value = next
  await nextTick()
  if (disposed)
    return
  const entering = (next ? surface : page).animate({ opacity: [0, 1] }, { duration: 300, easing: 'ease-out', fill: 'both' })
  fullscreen_animations.push(entering)
  if (! next) {
    leaving.cancel()
    underlay?.cancel()
  }
  await entering.finished
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

let editor: ReturnType<typeof useStoryEditor>
useStoryEditorViewState({
  key: () => props.viewStateKey,
  fullscreen, mode: editor_mode, audience: preview_audience, split_ratio, attachments_width,
  capture: () => editor.capture_position(), restore: position => editor.restore_position(position),
})
editor = useStoryEditor({
  model, host: editor_host, preview_pane, fullscreen, mode: editor_mode,
  readonly: () => props.readonly,
  allow_write: () => props.allowWrite?.() !== false,
  history_key: () => props.historyKey,
  sources: {
    stories: () => props.stories, story_id: () => props.storyId,
    attachments: () => props.attachments, folders: () => props.folders,
    stories_failure: () => props.storiesFailure,
    attachments_failure: () => props.attachmentsFailure,
    referenced_paths: () => props.referencedPaths ?? null,
  },
  on_lint: items => emit('lint', items),
  on_files_pasted: (files, position) => emit('files-pasted', files, position),
})
const { editor_ready, issues, search, jump_to_line, insert_at_position, apply_reference_changes, validate } = editor

watch(editor_mode, () => {
  mode_has_switched.value = true
})
watch(fullscreen, (active) => {
  document.documentElement.style.overflow = active ? 'hidden' : ''
})
onBeforeUnmount(() => {
  disposed = true
  fullscreen_transition?.skipTransition()
  fullscreen_animations.splice(0).forEach(animation => animation.cancel())
  document.documentElement.style.overflow = ''
})

defineExpose({ editor_mode, insert_at_position, track_upload_insertion: editor.track_upload_insertion, apply_reference_changes, validate })

const { markdown_pending, request_markdown, confirm_markdown, cancel_markdown } = useAttachmentMarkdown(() => props.attachments)
watch([() => props.viewStateKey, () => props.readonly], cancel_markdown)

async function on_drop(event: DragEvent) {
  drag_over.value = false
  if (props.readonly || props.allowWrite?.() === false)
    return
  // DataTransfer is readable only during the drop event, not after awaits.
  const attachment = get_content_attachment_drag_data(event.dataTransfer)
  const folder = attachment ? null : get_content_folder_drag_data(event.dataTransfer)
  const origin = attachment
    ? { path: attachment.file_name, kind: 'file' as const, is_image: attachment.is_image }
    : folder ? { path: folder.folder, kind: 'folder' as const } : null
  if (origin) {
    const position = editor.position_at_coords({ x: event.clientX, y: event.clientY })
    if (position === null)
      return
    const paths = attachment ? content_attachment_drag_file_names(attachment) : folder?.file_names ?? [origin.path]
    const selection = resolve_markdown_selection(paths, props.attachments, props.folders, origin)
    const insert = editor.track_attachment_insertion(position)
    request_markdown(selection, (_markdown, items) => insert(items))
    return
  }

  const picks = await attachment_picks_from_data_transfer(event.dataTransfer)
  if (! props.readonly && props.allowWrite?.() !== false && picks.length) {
    const position = editor.position_at_coords({ x: event.clientX, y: event.clientY })
    emit('files-dropped', picks, position)
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
  if (props.readonly) {
    drag_over.value = false
    if (event.dataTransfer)
      event.dataTransfer.dropEffect = 'none'
    return
  }
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
.editor-fullscreen :deep(.story-body h1),
.editor-fullscreen :deep(.story-body h2),
.editor-fullscreen :deep(.story-body h3),
.editor-fullscreen :deep(.story-body h4),
.editor-fullscreen :deep(.story-body h5),
.editor-fullscreen :deep(.story-body h6) {
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

:deep(.cm-tooltip.cm-tooltip-autocomplete) {
  background: var(--p-contextmenu-background);
  color: var(--p-contextmenu-color);
  border-color: var(--p-contextmenu-border-color);
  border-radius: var(--p-contextmenu-border-radius);
  box-shadow: var(--p-contextmenu-shadow);
  display: flex;
  flex-direction: column;
  max-height: 20em;
  max-width: min(32rem, calc(100vw - 2rem));
  box-sizing: border-box;
  overflow: hidden;
  padding: 0;
}

:deep(.cm-completion-source-status) {
  @apply whitespace-pre-line px-2 py-1.5;
  max-width: min(32rem, calc(100vw - 2rem));
}

/* Separate clipping from scrolling: the tooltip clips the native scrollbar
   to its rounded border, and its unpadded list owns the scroll area. */
:deep(.cm-tooltip.cm-tooltip-autocomplete > ul) {
  min-height: 0;
  min-width: 0;
  max-width: 100%;
  max-height: inherit;
  height: auto;
  overflow: hidden auto;
  padding: 0;
}

:deep(.cm-tooltip-autocomplete > ul > li[role='option']) {
  @apply transition-colors;
  /* The list scrolls and the title truncates; an item must not clip its content. */
  overflow: visible;
  margin: var(--p-contextmenu-list-padding);
  padding: var(--p-contextmenu-item-padding);
  border-radius: var(--p-contextmenu-item-border-radius);
}

:deep(.cm-tooltip-autocomplete > ul > li[role='option']:not(.content-item)) {
  @apply flex items-center;
  gap: var(--p-contextmenu-item-gap);
}

:deep(.cm-tooltip-autocomplete > ul > li.content-item) {
  @apply px-2 py-1;
}

:deep(.cm-tooltip-autocomplete > ul > li[role='option']:hover),
:deep(.cm-tooltip-autocomplete > ul > li[aria-selected='true']) {
  background: var(--p-contextmenu-item-focus-background);
  color: var(--p-contextmenu-item-focus-color);
}

:deep(.cm-tooltip.cm-tooltip-autocomplete > ul > completion-section) {
  @apply text-xs font-normal;
  font-style: normal;
  opacity: 1;
  background: var(--p-contextmenu-item-focus-background);
  padding: var(--p-contextmenu-item-padding);
  color: var(--p-contextmenu-color);
  border-bottom: 1px solid var(--p-contextmenu-separator-border-color);
}

:deep(.cm-tooltip.cm-tooltip-autocomplete > ul > completion-section:not(:first-child)) {
  border-top: 1px solid var(--p-contextmenu-separator-border-color);
  margin: 0;
}

:deep(.cm-completionMatchedText) {
  @apply font-bold no-underline;
}

:deep(li:not(.content-item) > .cm-completionLabel) {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

:deep(.cm-completionDetail) {
  @apply ml-2 shrink-0 text-xs not-italic text-slate-400 dark:text-slate-500;
}

/* Every option carries the lucide icon our renderer injects (the library's own
   glyph is off via `icons: false`), in a fixed-width column so the labels line
   up whatever the type. */
:deep(.completion-type-icon) {
  @apply h-4 w-4 shrink-0 transition;
  color: var(--p-contextmenu-item-icon-color);
}

:deep(.cm-tooltip-autocomplete > ul > li[aria-selected='true']) .completion-type-icon {
  color: var(--p-contextmenu-item-icon-focus-color);
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
