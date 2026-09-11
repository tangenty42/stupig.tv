// Autocompletion sources for the story markdown editor: `@story` references,
// attachment file names, front-matter `label:` tags and blockquote alert
// markers, plus the lucide type icons injected into the completion list.
import type { Completion, CompletionContext, CompletionResult } from '@codemirror/autocomplete'
import type { EditorView } from '@codemirror/view'
import type { ContentStoryAttachment, ContentStorySummary } from '@shared/types/content'
import { autocompletion } from '@codemirror/autocomplete'
import { compare_attachment_names } from '@shared/content-markdown'
import { content_rating_tiers, pinned_label, rating_label, story_rating } from '@shared/types/content'
import { alert_labels, alert_types } from '~/utils/content/alerts'

export interface EditorCompletionSources {
  stories: () => ContentStorySummary[]
  story_id: () => number | null
  attachments: () => ContentStoryAttachment[]
  /** Folder paths in scope, so a folder shorthand can be completed too. */
  folders: () => string[]
}

// `@` story completion: `[](@query` completes to `[](@title)`, a bare `@query`
// to a wrapped `[](@title)`. The token charset mirrors the shared reference
// regex (`[^)\s<>]`): titles may contain CJK punctuation like `，`, so the
// token must not be restricted to word characters.
const story_at_patterns = {
  link: /\((@[^)\s<>]*)$/u,
  bare: /(?:^|[\s(])(@[^)\s<>]*)$/u,
}
const story_at_valid = /^@[^)\s<>]*$/u

function story_completion_source(sources: EditorCompletionSources) {
  return (context: CompletionContext): CompletionResult | null => {
    const before = context.state.sliceDoc(0, context.pos)
    const link_match = story_at_patterns.link.exec(before)
    const bare_match = link_match ? null : story_at_patterns.bare.exec(before)
    const match = link_match ?? bare_match
    if (! match) {
      return null
    }
    const in_link = Boolean(link_match)
    const options: Completion[] = sources.stories()
      .filter(story => story.id !== sources.story_id())
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
}

// Attachment destination completion: offered inside a link destination `[](` /
// `![](` while the destination still looks like a story-relative path. Folders
// are offered in the same list — a folder enters the destination whole, which
// the preview then renders as a card or expands into its images.
//
// Slashes are allowed so a folder can be drilled into once it is accepted:
// `![](cards/` keeps the list alive and narrows to what is inside, which is what
// makes picking a folder useful rather than a dead end. A leading slash is not
// allowed, since that is an absolute path rather than a story-relative one.
const attachment_dest_pattern = /!?\[[^\]]*\]\(\s*([^)\s<>]*)$/
const attachment_dest_valid = /^(?!\/)[^@#:)\s<>]*$/

// Exported for tests: the destination completion is the one piece with matching
// rules worth pinning (folder shorthand, ordering, prefix narrowing).
export function attachment_completion_source(sources: EditorCompletionSources) {
  return (context: CompletionContext): CompletionResult | null => {
    const before = context.state.sliceDoc(0, context.pos)
    const match = attachment_dest_pattern.exec(before)
    if (! match) {
      return null
    }
    const query = match[1] ?? ''
    if (! attachment_dest_valid.test(query)) {
      return null
    }
    const folders: Completion[] = sources.folders().map(folder => ({
      label: folder,
      detail: '文件夹',
      type: 'folder',
      apply: folder,
    }))
    const files: Completion[] = sources.attachments().map(attachment => ({
      label: attachment.file_name,
      detail: attachment.is_image ? '图片' : '附件',
      type: attachment.is_image ? 'image' : 'file',
      apply: attachment.file_name,
    }))
    // One list for both, in the same natural order the attachment list uses.
    const options = [... folders, ... files]
      .sort((left, right) => compare_attachment_names(left.label, right.label))
    return {
      from: context.pos - query.length,
      to: context.pos,
      options,
      validFor: attachment_dest_valid,
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

function label_completion_source(sources: EditorCompletionSources) {
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
export const completion_icon_names = [... new Set(Object.values(completion_icon_by_type))]

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

export function create_completion_extensions(sources: EditorCompletionSources) {
  return autocompletion({
    override: [
      story_completion_source(sources),
      attachment_completion_source(sources),
      label_completion_source(sources),
      alert_marker_completion_source,
    ],
    addToOptions: [{
      render: completion_icon_renderer,
      position: 20,
    }],
  })
}
