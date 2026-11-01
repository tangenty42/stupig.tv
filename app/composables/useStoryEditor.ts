import type { AttachmentUploadPick } from '~/utils/content/attachment'
import type { EditorCompletionSources } from '~/utils/content/editor/completions'
import type { LintListItem } from '~/utils/content/editor/lint'
import type { StoryEditorPosition } from '~/utils/content/editor/view-state'
import { startCompletion } from '@codemirror/autocomplete'
import { indentWithTab } from '@codemirror/commands'
import { lintGutter } from '@codemirror/lint'
import { Annotation, Compartment, EditorState, Prec, Transaction } from '@codemirror/state'
import { EditorView, keymap, scrollPastEnd } from '@codemirror/view'
import { front_matter_line_count } from '@shared/content-markdown'
import { settings } from '@shared/settings'
import { basicSetup } from 'codemirror'
import { attachment_pick_from_file } from '~/utils/content/attachment'
import { alert_marker_plugin } from '~/utils/content/editor/alert-marker'
import { create_completion_extensions } from '~/utils/content/editor/completions'
import { editor_close_brackets, editor_markdown_lang } from '~/utils/content/editor/language'
import { build_diagnostics, create_markdown_lint, diagnostics_to_items, refresh_markdown_lint, story_lint_config } from '~/utils/content/editor/lint'
import { search_field } from '~/utils/content/editor/search'
import { theme_extensions } from '~/utils/content/editor/themes'

interface StoryEditorOptions {
  model: Ref<string>
  host: Ref<HTMLElement | undefined>
  preview_pane: Ref<HTMLElement | undefined>
  fullscreen: Ref<boolean>
  mode: Ref<'edit' | 'preview'>
  readonly?: () => boolean
  allow_write?: () => boolean
  sources: EditorCompletionSources
  on_lint: (items: LintListItem[]) => void
  on_files_pasted: (files: AttachmentUploadPick[], position: number) => void
}

/** Owns one CodeMirror instance and every subscription that depends on it. */
export function useStoryEditor(options: StoryEditorOptions) {
  const { model, sources, fullscreen } = options
  const color_mode = useMyColorMode()
  const editor_ready = ref(false)
  const issues = ref<LintListItem[]>([])
  let view: EditorView | null = null
  let disposed = false
  const theme_compartment = new Compartment()
  const overscroll_compartment = new Compartment()
  const readonly_compartment = new Compartment()
  const external_update = Annotation.define<boolean>()
  const readonly_extensions = () => [EditorState.readOnly.of(!! options.readonly?.()), EditorView.editable.of(! options.readonly?.())]
  const search = useMarkdownSearch(() => view)
  let restoring_scroll = false
  let pending_position: StoryEditorPosition | null = null
  let restore_generation = 0
  let restore_observer: ResizeObserver | null = null
  const scroll_sync = useMarkdownEditorScrollSync(() => view, options.preview_pane, () => front_matter_line_count(model.value), () => restoring_scroll)
  const restore_measure_key = {}
  const intent_events = ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const

  function capture_position(): StoryEditorPosition | null {
    if (! view)
      return null
    if (pending_position)
      return pending_position
    return {
      anchor: view.state.selection.main.anchor, head: view.state.selection.main.head,
      editor: { top: view.scrollDOM.scrollTop, left: view.scrollDOM.scrollLeft },
      preview: { top: options.preview_pane.value?.scrollTop ?? 0, left: options.preview_pane.value?.scrollLeft ?? 0 },
      page: { top: window.scrollY ?? 0, left: window.scrollX ?? 0 },
    }
  }

  function cancel_restore() {
    restore_generation ++
    pending_position = null
    restoring_scroll = false
    restore_observer?.disconnect()
    restore_observer = null
  }

  function measure_position() {
    const active_view = view
    const position = pending_position
    const generation = restore_generation
    if (! active_view || ! position || disposed)
      return
    restoring_scroll = true
    active_view.requestMeasure({
      key: restore_measure_key,
      read: () => ({
        top: Math.min(position.editor.top, Math.max(0, active_view.scrollDOM.scrollHeight - active_view.scrollDOM.clientHeight)),
        left: Math.min(position.editor.left, Math.max(0, active_view.scrollDOM.scrollWidth - active_view.scrollDOM.clientWidth)),
      }),
      write: (scroll) => {
        if (disposed || view !== active_view || generation !== restore_generation)
          return
        active_view.scrollDOM.scrollTop = scroll.top
        active_view.scrollDOM.scrollLeft = scroll.left
        const pane = options.preview_pane.value
        if (pane) {
          pane.scrollTop = position.preview.top
          pane.scrollLeft = position.preview.left
        }
        window.scrollTo?.(position.page.left, position.page.top)
        // Scroll events from both assignments must not drive each other.
        if (typeof requestAnimationFrame === 'function') {
          requestAnimationFrame(() => {
            if (generation === restore_generation)
              restoring_scroll = false
          })
        }
        else {
          restoring_scroll = false
        }
      },
    })
  }

  function on_page_scrolled() {
    // Router/native scroll restoration can finish after the editor mounts.
    // Keep the saved page offset until the user deliberately takes control.
    if (pending_position && Math.abs(window.scrollY - pending_position.page.top) > 1)
      measure_position()
  }

  function restore_position(position: StoryEditorPosition, selection = true) {
    cancel_restore()
    if (! view || disposed)
      return
    pending_position = position
    if (selection) {
      const length = view.state.doc.length
      view.dispatch({ selection: { anchor: Math.min(length, position.anchor), head: Math.min(length, position.head) } })
    }
    // Retry after delayed preview images, font/layout measurement and Teleport.
    // User input immediately takes ownership and disconnects the observer.
    if (typeof ResizeObserver !== 'undefined') {
      restore_observer = new ResizeObserver(measure_position)
      restore_observer.observe(view.contentDOM)
      const body = options.preview_pane.value?.firstElementChild
      if (body)
        restore_observer.observe(body)
      restore_observer.observe(document.documentElement)
    }
    const generation = restore_generation
    void nextTick(() => {
      if (generation === restore_generation)
        measure_position()
    })
  }
  const get_lint_config = () => story_lint_config(settings.app.content.story, sources.stories(), sources.story_id(), sources.attachments(), sources.folders())
  const lint_source = create_markdown_lint(get_lint_config, (items) => {
    if (! view || disposed)
      return
    issues.value = items
    options.on_lint(items)
  })
  const initial_doc = EditorState.create({ doc: model.value }).doc
  issues.value = diagnostics_to_items(build_diagnostics(model.value, initial_doc, get_lint_config()), initial_doc)
  const autocomplete_ext = create_completion_extensions(sources)

  watch(options.mode, (mode) => {
    if (mode !== 'edit')
      search.close_search()
  })
  watch(() => options.readonly?.(), () => {
    view?.dispatch({ effects: readonly_compartment.reconfigure(readonly_extensions()) })
  }, { flush: 'sync' })

  watch(fullscreen, async (active, _previous, on_cleanup) => {
    let current = true
    on_cleanup(() => current = false)
    const active_view = view
    view?.dispatch({ effects: overscroll_compartment.reconfigure(active ? scrollPastEnd() : []) })
    if (active) {
      await nextTick()
      // The mode can change or the owner can unmount while Teleport settles.
      if (! current || disposed || ! active_view || view !== active_view)
        return
      scroll_sync.attach()
    }
    else {
      scroll_sync.detach()
    }
    view?.requestMeasure()
  })

  onMounted(() => {
    window.addEventListener('scroll', on_page_scrolled, { passive: true })
    for (const type of intent_events)
      window.addEventListener(type, cancel_restore, { capture: true, passive: true })
    view = new EditorView({
      parent: options.host.value!,
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
          overscroll_compartment.of(fullscreen.value ? scrollPastEnd() : []),
          readonly_compartment.of(readonly_extensions()),
          // Check the monotonic deadline at each edit, including undo/redo after
          // browser suspension. Authorized server patches use an explicit tag.
          EditorState.transactionFilter.of(transaction => ! transaction.docChanged || transaction.annotation(external_update) || (! options.readonly?.() && options.allow_write?.() !== false) ? transaction : []),
          EditorView.lineWrapping,
          EditorView.domEventHandlers({
            paste: (event, editor_view) => {
              if (editor_view.state.readOnly) {
                event.preventDefault()
                return true
              }
              const files = event.clipboardData?.files ? [... event.clipboardData.files] : []
              if (! files.length)
                return false
              event.preventDefault()
              options.on_files_pasted(files.map(attachment_pick_from_file), editor_view.state.selection.main.from)
              return true
            },
          }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged)
              model.value = update.state.doc.toString()
            search.on_editor_update(update)
            // Backspacing reopens @ completion; its source rejects unrelated edits.
            if (update.transactions.some(tr => tr.isUserEvent('delete.backward')))
              startCompletion(update.view)
          }),
          EditorView.contentAttributes.of({ 'aria-label': '档案内容 Markdown 编辑器' }),
        ],
      }),
    })
    editor_ready.value = true
    void nextTick(() => {
      if (disposed)
        return
      if (fullscreen.value)
        scroll_sync.attach()
      view?.requestMeasure()
    })
  })

  onBeforeUnmount(() => {
    disposed = true
    cancel_restore()
    window.removeEventListener('scroll', on_page_scrolled)
    for (const type of intent_events)
      window.removeEventListener(type, cancel_restore, true)
    // Detach while both DOM endpoints and the instance are still available.
    scroll_sync.detach()
    view?.destroy()
    view = null
    editor_ready.value = false
  })

  watch(color_mode, (mode) => {
    view?.dispatch({ effects: theme_compartment.reconfigure(theme_extensions(mode)) })
  })
  watch(model, (value) => {
    if (view && value !== view.state.doc.toString()) {
      const position = capture_position()
      const changes = view.state.changes({ from: 0, to: view.state.doc.length, insert: value })
      const selection = view.state.selection.main
      view.dispatch({ changes, selection: { anchor: Math.min(selection.anchor, changes.newLength), head: Math.min(selection.head, changes.newLength) }, annotations: external_update.of(true) })
      if (position)
        restore_position({ ... position, anchor: view.state.selection.main.anchor, head: view.state.selection.main.head }, false)
    }
  })
  watch([sources.stories, sources.attachments, sources.folders], () => {
    if (view)
      refresh_markdown_lint(view)
  })

  function jump_to_line(from: number) {
    if (! view)
      return
    view.dispatch({ selection: { anchor: from }, scrollIntoView: true })
    view.focus()
  }

  function insert_at_position(text: string, from: number, to = from) {
    if (! view || options.readonly?.() || options.allow_write?.() === false)
      return
    const doc = view.state.doc
    const char_before = from > 0 ? doc.sliceString(from - 1, from) : ''
    const char_after = from < doc.length ? doc.sliceString(from, from + 1) : ''
    const prefix = char_before && char_before !== '\n' ? '\n' : ''
    const suffix = from >= doc.length || (char_after && char_after !== '\n') ? '\n' : ''
    const insert_text = `${prefix}${text}${suffix}`
    view.dispatch({ changes: { from, to, insert: insert_text }, selection: { anchor: from + insert_text.length } })
    view.focus()
  }

  function apply_reference_changes(snapshot: string, changes: { from: number, to: number, insert: string }[]) {
    if (disposed || model.value !== snapshot || (view && view.state.doc.toString() !== snapshot))
      return false
    if (view) {
      const position = capture_position()
      view.dispatch({ changes, annotations: [Transaction.addToHistory.of(false), external_update.of(true)] })
      if (position)
        restore_position({ ... position, anchor: view.state.selection.main.anchor, head: view.state.selection.main.head }, false)
    }
    else {
      model.value = changes.reduceRight((text, change) => text.slice(0, change.from) + change.insert + text.slice(change.to), snapshot)
    }
    return true
  }

  // Save uses the same diagnostics immediately, without waiting for debounce.
  function validate() {
    if (! view)
      return [] as LintListItem[]
    const doc = view.state.doc
    return diagnostics_to_items(build_diagnostics(doc.toString(), doc, get_lint_config()), doc)
  }

  function position_at_coords(coords: { x: number, y: number }) {
    return view ? (view.posAtCoords(coords) ?? view.state.selection.main.from) : null
  }

  return { editor_ready, issues, search, jump_to_line, insert_at_position, apply_reference_changes, validate, position_at_coords, capture_position, restore_position }
}
