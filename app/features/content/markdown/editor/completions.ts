// Autocompletion sources for the story markdown editor: `@story` references,
// attachment file names, front-matter `label:` tags and blockquote alert
// markers, plus the lucide type icons injected into the completion list.
import type { Completion, CompletionResult } from '@codemirror/autocomplete'
import type { EditorState } from '@codemirror/state'
import type { Tooltip } from '@codemirror/view'
import type { ContentStoryAttachment, ContentStorySummary } from '@shared/types/content'
import type { ContentItemPresentation } from '~/features/content/attachments/presentation'
import { autocompletion, closeCompletion, CompletionContext, completionStatus, startCompletion } from '@codemirror/autocomplete'
import { syntaxTree } from '@codemirror/language'
import { Prec, StateEffect, StateField } from '@codemirror/state'
import { EditorView, keymap, showTooltip } from '@codemirror/view'
import { html_no_markdown_tags } from '@shared/content-html'
import { attachment_folder_of, compare_attachment_items } from '@shared/content-markdown'
import { attachment_ref_scheme, content_name_key, format_attachment_ref, format_story_ref, story_ref_scheme } from '@shared/content-reference'
import { content_rating_tiers, pinned_label, rating_label } from '@shared/types/content'
import { content_attachment_markdown, content_folder_markdown } from '~/features/content/attachments/drag'
import { attachment_item_presentation, draft_unused_attachment_label, folder_item_presentation, unused_attachment_class, unused_attachment_icon } from '~/features/content/attachments/presentation'
import { attachment_can_read, attachment_is_restricted, file_icon_names } from '~/features/content/attachments/rules'
import { alert_labels, alert_types } from '~/features/content/markdown/alerts'

interface ReferenceCompletion extends Completion {
  presentation: ContentItemPresentation
  attachment_key?: string
}

export type CompletionSourceFailure = 'load' | 'refresh'

export interface EditorCompletionSources {
  stories: () => ContentStorySummary[]
  story_id: () => number | null
  attachments: () => ContentStoryAttachment[]
  /** Folder paths in scope, so a folder shorthand can be completed too. */
  folders: () => string[]
  stories_failure?: () => CompletionSourceFailure | undefined
  attachments_failure?: () => CompletionSourceFailure | undefined
  referenced_paths?: () => ReadonlySet<string> | null
}

const reference_destination_pattern = /!?\[[^\]]*\]\(\s*([^)\s<>]*)$/
const bare_reference_pattern = /(?:^|[\s(])(@[^/)\s<>]*)$/u
const at_reference_valid = /^@[^/)\s<>]*$/u
const reference_query_valid = /^[^/)\s<>]*$/u
const story_section = { name: '蠢猪档案', rank: 0 }
const attachment_section = { name: '附件', rank: 1 }

export function compare_reference_completions(left: Completion, right: Completion) {
  if (left.section === attachment_section && right.section === attachment_section)
    return compare_attachment_items({ name: left.displayLabel ?? left.label, is_folder: left.type === 'folder' }, { name: right.displayLabel ?? right.label, is_folder: right.type === 'folder' })
  return (left.sortText ?? left.label).localeCompare(right.sortText ?? right.label)
}

function reference_completion_match(context: CompletionContext) {
  for (let node = syntaxTree(context.state).resolveInner(context.pos, - 1); node; node = node.parent!) {
    if (/^(?:CodeBlock|FencedCode|InlineCode|CodeText|HTMLTag|CommentBlock)$/.test(node.name))
      return null
    if (node.name === 'Element') {
      const tag = /^<([a-z][\w-]*)\b/i.exec(context.state.sliceDoc(node.from, node.to))?.[1]
      if (tag && html_no_markdown_tags.has(tag.toLowerCase()))
        return null
    }
  }
  const before = context.state.sliceDoc(0, context.pos)
  const destination_match = reference_destination_pattern.exec(before)
  const bare_match = destination_match ? null : bare_reference_pattern.exec(before)
  const token = destination_match?.[1] ?? bare_match?.[1]
  if (token === undefined)
    return null
  const in_link = Boolean(destination_match)
  const at = token.startsWith('@')
  const attachment_only = in_link && token.startsWith(attachment_ref_scheme)
  const story_only = in_link && token.startsWith(story_ref_scheme)
  // Auto-paired parentheses leave the cursor in an empty destination. Offer
  // references there too, while an unclosed bare destination stays explicit.
  const empty_destination = in_link && token === ''
    && (context.explicit || context.state.sliceDoc(context.pos, context.pos + 1) === ')')
  if (! at && ! attachment_only && ! story_only && ! empty_destination)
    return null
  return { token, in_link, at, attachment_only, story_only }
}

/** One source and one replacement range for the two reference sections. */
export function reference_completion_source(sources: EditorCompletionSources) {
  return (context: CompletionContext): CompletionResult | null => {
    const match = reference_completion_match(context)
    if (! match)
      return null
    const { token, in_link, at, attachment_only, story_only } = match
    let from = context.pos - token.length
    let parent: string | null = null
    if (attachment_only) {
      const path = token.slice(attachment_ref_scheme.length)
      const slash = path.lastIndexOf('/')
      parent = slash === - 1 ? null : path.slice(0, slash)
      if (parent === '' || parent?.split('/').some(segment => ! segment))
        return null
      from += attachment_ref_scheme.length + slash + 1
    }
    else if (story_only) {
      from += story_ref_scheme.length
    }
    // A completion replaces the whole destination: whatever still sits
    // between the cursor and the closing delimiter belongs to the half-typed
    // name (e.g. the old `.png` after `this_is_a_file_`) and must go too.
    // The scan is bounded: it stops at the line end and at the first
    // delimiter (`)`, `<`, `>`, whitespace) the destination cannot contain.
    const destination_end = (view: EditorView, end: number) => {
      if (! in_link)
        return end
      const doc = view.state.doc
      const max = Math.min(doc.length, doc.lineAt(end).to)
      const tail = doc.sliceString(end, max)
      const stop = tail.search(/[)\s<>]/)
      return stop === - 1 ? max : end + stop
    }
    const apply_reference = (destination: string, markdown: string, folder = false) =>
      (view: EditorView, _completion: Completion, start: number, end: number) => {
        const replace_end = destination_end(view, end)
        const insert = in_link ? `${destination})` : markdown
        const trailing = in_link && view.state.doc.sliceString(replace_end, replace_end + 1) === ')'
        view.dispatch({
          changes: { from: start, to: trailing ? replace_end + 1 : replace_end, insert },
          selection: { anchor: start + insert.length - (folder ? 1 : 0) },
          userEvent: 'input.complete',
        })
      }
    const display_name = (path: string) => parent ? path.slice(parent.length + 1) : path
    const label = (name: string) => at ? `@${name}` : name
    const attachment_destination = (path: string) => attachment_only ? display_name(path) : format_attachment_ref(path)
    const folders: ReferenceCompletion[] = sources.folders().filter(folder => attachment_folder_of(folder) === parent).map(folder => ({
      label: label(display_name(folder)),
      displayLabel: display_name(folder),
      attachment_key: content_name_key(folder),
      presentation: folder_item_presentation(),
      type: 'folder',
      section: attachment_section,
      apply: apply_reference(attachment_destination(folder), content_folder_markdown(folder), true),
    }))
    const available_attachments = sources.attachments()
    const files: ReferenceCompletion[] = available_attachments.filter(attachment => attachment_folder_of(attachment.file_name) === parent).map(attachment => ({
      label: label(display_name(attachment.file_name)),
      displayLabel: display_name(attachment.file_name),
      attachment_key: content_name_key(attachment.file_name),
      presentation: attachment_item_presentation(attachment),
      type: attachment_is_restricted(attachment) ? (attachment_can_read(attachment) ? 'private' : 'private-denied') : (attachment.is_image ? 'image' : 'file'),
      section: attachment_section,
      apply: apply_reference(attachment_destination(attachment.file_name), content_attachment_markdown(attachment)),
    }))
    const attachments = [... folders, ... files]
      .sort(compare_reference_completions)
    const stories: ReferenceCompletion[] = sources.stories().filter(story => story.id !== sources.story_id()).map(story => ({
      label: label(story.title),
      displayLabel: story.title,
      presentation: { icon: 'lucide:book-open', tone: 'muted' },
      type: 'story',
      section: story_section,
      apply: apply_reference(story_only ? story.title : format_story_ref(story.title), `[](${format_story_ref(story.title)})`),
    }))
    return {
      from,
      to: context.pos,
      options: attachment_only ? attachments : story_only ? stories : [... stories, ... attachments],
      validFor: at ? at_reference_valid : reference_query_valid,
    }
  }
}

// Special `#`-prefixed labels (rating tiers + pin) on the front-matter `label:`
// line, so a bare `#` lists the allowed hidden tags.
const special_labels = [... content_rating_tiers.map(rating_label), pinned_label]
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

function label_completion_match(state: EditorState, position: number) {
  const line = state.doc.lineAt(position)
  const before = state.sliceDoc(line.from, position)
  if (! label_line_pattern.test(before))
    return null
  for (let node = syntaxTree(state).resolveInner(position, - 1); node; node = node.parent!) {
    if (node.name === 'FrontMatter')
      return label_token_pattern.exec(before)
  }
  return null
}

export function label_completion_source(sources: EditorCompletionSources) {
  // Ordinary (non-`#`) labels already in use across OTHER stories (the story
  // being edited is excluded — its DB labels are already on its own label
  // line), deduplicated, so typing a plain label word can reuse an existing
  // tag. Cached by stories-array identity: completion fires per keystroke.
  let cached_stories: ContentStorySummary[] | null = null
  let cached_labels: string[] = []
  const existing_labels = () => {
    const stories = sources.stories()
    if (stories === cached_stories) {
      return cached_labels
    }
    const labels = new Set<string>()
    for (const story of stories) {
      if (story.id === sources.story_id()) {
        continue
      }
      for (const label of story.labels) {
        if (! label.startsWith('#')) {
          labels.add(label)
        }
      }
    }
    cached_stories = stories
    cached_labels = [... labels].sort((a, b) => a.localeCompare(b, 'zh-CN'))
    return cached_labels
  }

  return (context: CompletionContext): CompletionResult | null => {
    const token_match = label_completion_match(context.state, context.pos)
    if (! token_match) {
      return null
    }
    const query = token_match[1] ?? ''
    const is_hash = query.startsWith('#')
    const candidates = is_hash ? special_labels : existing_labels()
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
}

// Blockquote alert markers `> [!NOTE]` etc. complete the marker after `[!`.
// Requires at least one `>` so the marker is suggested only where it will
// actually render as an alert (markdown-it needs a blockquote).
const alert_marker_pattern = /^[ \t]*(?:>[ \t]?)+\[![a-z]*$/i
const alert_marker_valid = /^\[![a-z]*$/i

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
  const options: Completion[] = alert_types.map(marker => ({
    label: `[!${marker}]`,
    detail: alert_labels[marker],
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

// Custom completion types render a lucide icon in the list (including
// `keyword`, replacing CodeMirror's built-in glyph). The iconify classes must
// be preloaded by the component so the injected spans display.
const completion_icon_by_type: Record<string, string> = {
  story: 'lucide:book-open',
  file: 'lucide:file',
  image: 'lucide:image',
  folder: 'lucide:folder',
  keyword: 'lucide:tag',
}
export const completion_icon_names = [... new Set([
  ... Object.values(completion_icon_by_type),
  ... file_icon_names,
  'lucide:chevron-right',
  unused_attachment_icon,
])]

// Injects the type icon into an autocomplete option. The span keeps its width
// for a type with no icon, so every label starts at the same x.
function completion_icon_renderer(completion: Completion): Node {
  const presentation = (completion as Partial<ReferenceCompletion>).presentation
  const icon = presentation?.icon ?? (completion.type ? completion_icon_by_type[completion.type] : undefined)
  const icon_class = presentation ? 'content-item-icon' : 'completion-type-icon'
  const span = document.createElement('span')
  span.className = icon ? `${icon_class} iconify i-${icon}` : icon_class
  span.setAttribute('aria-hidden', 'true')
  return span
}

function update_unused_marker(marker: HTMLElement, referenced_paths: ReadonlySet<string> | null) {
  marker.hidden = referenced_paths === null || referenced_paths.has(marker.dataset.attachmentUsageKey!)
}

export function refresh_completion_usage(view: EditorView, referenced_paths: ReadonlySet<string> | null) {
  for (const marker of view.dom.querySelectorAll<HTMLElement>('[data-attachment-usage-key]'))
    update_unused_marker(marker, referenced_paths)
}

function render_unused_marker(completion: Completion, referenced_paths: ReadonlySet<string> | null) {
  const key = (completion as Partial<ReferenceCompletion>).attachment_key
  if (key === undefined)
    return null
  const marker = document.createElement('span')
  marker.dataset.attachmentUsageKey = key
  marker.className = unused_attachment_class
  marker.title = draft_unused_attachment_label
  marker.setAttribute('role', 'img')
  marker.setAttribute('aria-label', draft_unused_attachment_label)
  const icon = marker.appendChild(document.createElement('span'))
  icon.className = `iconify i-${unused_attachment_icon}`
  icon.setAttribute('aria-hidden', 'true')
  update_unused_marker(marker, referenced_paths)
  return marker
}

/** Failure belongs to the source needed at this position, not to an empty query result. */
export function completion_source_messages(state: EditorState, sources: EditorCompletionSources) {
  const stories_failure = sources.stories_failure?.()
  const attachments_failure = sources.attachments_failure?.()
  if (! stories_failure && ! attachments_failure)
    return []
  const position = state.selection.main.head
  const reference = reference_completion_match(new CompletionContext(state, position, true))
  const label = label_completion_match(state, position)?.[1]
  const messages: string[] = []
  if (stories_failure && ((reference && ! reference.attachment_only) || (label !== undefined && ! label.startsWith('#'))))
    messages.push(stories_failure === 'refresh' ? '档案列表更新失败' : '档案来源暂不可用')
  if (attachments_failure && reference && ! reference.story_only)
    messages.push(attachments_failure === 'refresh' ? '附件列表更新失败' : '附件来源暂不可用')
  return messages
}

const completion_sources_changed = StateEffect.define<null>()
const completion_status_focus = StateEffect.define<boolean>()
const completion_status_dismissed = StateEffect.define<boolean>()

interface CompletionSourceStatus {
  focused: boolean
  dismissed: boolean
  message: string
  tooltip: Tooltip | null
}

function completion_source_status(sources: EditorCompletionSources) {
  const field = StateField.define<CompletionSourceStatus>({
    create: () => ({ focused: false, dismissed: false, message: '', tooltip: null }),
    update(value, transaction) {
      let { focused, dismissed } = value
      if (transaction.docChanged || transaction.selection)
        dismissed = false
      for (const effect of transaction.effects) {
        if (effect.is(completion_status_focus)) {
          focused = effect.value
          if (focused)
            dismissed = false
        }
        else if (effect.is(completion_status_dismissed)) {
          dismissed = effect.value
        }
      }
      const message = completion_source_messages(transaction.state, sources).join('\n')
      if (message !== value.message)
        dismissed = false
      const pos = transaction.state.selection.main.head
      const visible = focused && ! dismissed && ! transaction.state.readOnly && Boolean(message)
      if (focused === value.focused && dismissed === value.dismissed && message === value.message
        && (visible ? value.tooltip?.pos === pos : value.tooltip === null)) {
        return value
      }
      const tooltip: Tooltip | null = visible
        ? {
            pos,
            above: true,
            create: () => {
              const dom = document.createElement('div')
              dom.className = 'cm-completion-source-status'
              dom.setAttribute('role', 'status')
              dom.textContent = message
              return { dom }
            },
          }
        : null
      return { focused, dismissed, message, tooltip }
    },
    provide: value => showTooltip.from(value, state => state.tooltip),
  })
  const start = (view: EditorView) => {
    view.dispatch({ effects: completion_status_dismissed.of(false) })
    return startCompletion(view)
  }
  return [
    field,
    EditorView.focusChangeEffect.of((_state, focused) => completion_status_focus.of(focused)),
    Prec.highest(keymap.of([
      { key: 'Ctrl-Space', run: start },
      // Windows input handling can consume the default Ctrl+Space.
      { key: 'Ctrl-Shift-Space', run: start },
      { key: 'Escape', run: (view) => {
        if (! view.state.field(field).tooltip)
          return false
        view.dispatch({ effects: completion_status_dismissed.of(true) })
        closeCompletion(view)
        return true
      } },
    ])),
  ]
}

/** Recompute status from the current source state, retaining dismissed/no-match behavior. */
export function refresh_completion_sources(view: EditorView) {
  const open = completionStatus(view.state) !== null
  view.dispatch({ effects: completion_sources_changed.of(null) })
  if (open)
    startCompletion(view)
}

export function create_completion_extensions(sources: EditorCompletionSources) {
  return [completion_source_status(sources), autocompletion({
    compareCompletions: compare_reference_completions,
    override: [
      reference_completion_source(sources),
      label_completion_source(sources),
      alert_marker_completion_source,
    ],
    // The library's own icon renderer renders a `cm-completionIcon-<type>`
    // element for every option, and only known type names get a glyph through
    // its stylesheet — for the rest it is an empty box that still takes
    // `0.8em + 0.6em`, which indented exactly the types missing from a CSS
    // hide-list (the private attachments sat right of the public ones).
    // Ours replaces it outright, so the label column is flush for every type.
    icons: false,
    optionClass: (completion) => {
      const presentation = (completion as Partial<ReferenceCompletion>).presentation
      return presentation ? `content-item content-item-${presentation.tone}` : ''
    },
    addToOptions: [{
      render: completion_icon_renderer,
      position: 20,
    }, {
      render: completion => sources.referenced_paths ? render_unused_marker(completion, sources.referenced_paths()) : null,
      position: 90,
    }],
  })]
}
