import type { ViewUpdate } from '@codemirror/view'
import type { SearchMatch, SearchSpec } from '~/utils/content/editor/search'
import { EditorSelection } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { build_search_regex, replacement_text, search_field, set_search_spec_effect } from '~/utils/content/editor/search'

/**
 * Find & replace state and actions for the story markdown editor, sharing the
 * search_field StateField with the editor (match decorations) and the search
 * panel component (inputs, buttons). The returned reactive object unwraps the
 * refs, so the panel can v-model its fields via toRefs.
 */
export function useMarkdownSearch(get_view: () => EditorView | null) {
  const open = ref(false)
  const query = ref('')
  const replace = ref('')
  const match_case = ref(false)
  const match_regexp = ref(false)
  const match_word = ref(false)
  const match_count = ref(0)
  const match_active = ref(- 1)
  // Bumped on every open_search() so the panel can re-focus its input even
  // when the panel was already open (Mod-f in the editor).
  const activation = ref(0)

  function current_spec(): SearchSpec {
    return {
      query: query.value,
      case_sensitive: match_case.value,
      regexp: match_regexp.value,
      whole_word: match_word.value,
    }
  }

  const regex_invalid = computed(() => {
    if (! query.value || ! match_regexp.value)
      return false
    return build_search_regex(current_spec()) === null
  })

  const status_text = computed(() => {
    if (! query.value)
      return ''
    if (regex_invalid.value)
      return '正则表达式无效'
    if (! match_count.value)
      return '无结果'
    if (match_active.value < 0)
      return `共 ${match_count.value} 处`
    return `${match_active.value + 1}/${match_count.value}`
  })

  function sync_spec() {
    const view = get_view()
    if (! view || ! open.value)
      return
    view.dispatch({ effects: set_search_spec_effect.of(current_spec()) })
  }

  watch([query, match_case, match_regexp, match_word], sync_spec)

  function open_search() {
    open.value = true
    const view = get_view()
    if (view) {
      const selection = view.state.selection.main
      if (! selection.empty) {
        const selected = view.state.sliceDoc(selection.from, selection.to)
        if (! selected.includes('\n'))
          query.value = selected
      }
    }
    sync_spec()
    activation.value += 1
  }

  function close_search() {
    if (! open.value)
      return
    open.value = false
    match_count.value = 0
    match_active.value = - 1
    const view = get_view()
    view?.dispatch({ effects: set_search_spec_effect.of(null) })
    view?.focus()
  }

  function select_match(match: SearchMatch) {
    get_view()?.dispatch({
      selection: { anchor: match.from, head: match.to },
      effects: EditorView.scrollIntoView(EditorSelection.range(match.from, match.to), { y: 'center' }),
      userEvent: 'select.search',
    })
  }

  function step_match(direction: 1 | - 1) {
    const view = get_view()
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
    const view = get_view()
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

  function replace_current() {
    const view = get_view()
    if (! view)
      return
    const field_value = view.state.field(search_field)
    const spec = field_value.spec
    if (! spec)
      return
    const selection = view.state.selection.main
    const match = field_value.matches.find(item => item.from === selection.from && item.to === selection.to)
    if (! match) {
      step_match(1)
      return
    }
    const replacement = replacement_text(spec, view.state.sliceDoc(match.from, match.to), replace.value)
    if (replacement === null)
      return
    view.dispatch({
      changes: { from: match.from, to: match.to, insert: replacement },
      selection: { anchor: match.from + replacement.length },
      userEvent: 'input.replace',
    })
    step_match(1)
  }

  function replace_all() {
    const view = get_view()
    if (! view)
      return
    const field_value = view.state.field(search_field)
    const spec = field_value.spec
    if (! spec || ! field_value.matches.length)
      return
    const changes: { from: number, to: number, insert: string }[] = []
    for (const match of field_value.matches) {
      const replacement = replacement_text(spec, view.state.sliceDoc(match.from, match.to), replace.value)
      if (replacement === null)
        return
      changes.push({ from: match.from, to: match.to, insert: replacement })
    }
    view.dispatch({ changes, userEvent: 'input.replace.all' })
  }

  /** Keep the panel's match counters in sync; wire into the editor's updateListener. */
  function on_editor_update(update: ViewUpdate) {
    if (! open.value)
      return
    const field_value = update.state.field(search_field)
    match_count.value = field_value.matches.length
    match_active.value = field_value.active
  }

  return reactive({
    open,
    query,
    replace,
    match_case,
    match_regexp,
    match_word,
    match_count,
    match_active,
    activation,
    regex_invalid,
    status_text,
    open_search,
    close_search,
    find_next,
    find_previous,
    select_all_matches,
    replace_current,
    replace_all,
    on_editor_update,
  })
}

export type MarkdownSearch = ReturnType<typeof useMarkdownSearch>
