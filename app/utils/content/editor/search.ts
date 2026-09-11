import type { EditorState } from '@codemirror/state'
// Find & replace state for the story markdown editor: a StateField holding
// the search spec, the match list and the highlight decorations. The
// composable (useMarkdownSearch) drives it via set_search_spec_effect and
// reads matches back for stepping and replacing.
import type { DecorationSet } from '@codemirror/view'
import { StateEffect, StateField } from '@codemirror/state'
import { Decoration, EditorView } from '@codemirror/view'

export interface SearchSpec {
  query: string
  case_sensitive: boolean
  regexp: boolean
  whole_word: boolean
}

export interface SearchMatch {
  from: number
  to: number
}

export interface SearchFieldValue {
  spec: SearchSpec | null
  matches: SearchMatch[]
  active: number
  decorations: DecorationSet
}

export const set_search_spec_effect = StateEffect.define<SearchSpec | null>()
const search_match_mark = Decoration.mark({ class: 'cm-search-hit' })
const search_active_mark = Decoration.mark({ class: 'cm-search-hit-active' })

function escape_regexp_source(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function build_search_source(spec: SearchSpec) {
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

export function build_search_regex(spec: SearchSpec) {
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

export const search_field = StateField.define<SearchFieldValue>({
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

/** Compute the replacement for one match; null when the regexp is invalid. */
export function replacement_text(spec: SearchSpec, matched: string, replace_with: string) {
  if (! spec.regexp)
    return replace_with
  const source = build_search_source(spec)
  if (! source)
    return null
  try {
    return matched.replace(new RegExp(`^(?:${source})$`, spec.case_sensitive ? 'u' : 'iu'), replace_with)
  }
  catch {
    return null
  }
}
