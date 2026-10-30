import type { AttachmentUploadPick } from '~/utils/content/attachment'
import type { EditorCompletionSources } from '~/utils/content/editor/completions'
import type { LintListItem } from '~/utils/content/editor/lint'
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
  const scroll_sync = useMarkdownEditorScrollSync(() => view, options.preview_pane, () => front_matter_line_count(model.value))
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
    if (view && value !== view.state.doc.toString())
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value }, annotations: external_update.of(true) })
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
    if (view)
      view.dispatch({ changes, annotations: [Transaction.addToHistory.of(false), external_update.of(true)] })
    else
      model.value = changes.reduceRight((text, change) => text.slice(0, change.from) + change.insert + text.slice(change.to), snapshot)
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

  return { editor_ready, issues, search, jump_to_line, insert_at_position, apply_reference_changes, validate, position_at_coords }
}
