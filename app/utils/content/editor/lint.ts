// The editor's combined lint: story front-matter/schema checks
// (parse_story_markdown), raw HTML grammar checks (build_html_diagnostics)
// and markdownlint, merged into one diagnostic list.
import type { Diagnostic } from '@codemirror/lint'
import type { Text } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import type { ContentMarkdownConfig } from '@shared/content-markdown'
import type { ContentStorySummary } from '@shared/types/content'
import type { Configuration as MarkdownlintConfiguration } from 'markdownlint'
import { forceLinting, linter } from '@codemirror/lint'
import { StateEffect } from '@codemirror/state'
import { parse_story_markdown } from '@shared/content-markdown'
import { build_html_diagnostics } from '@shared/html-lint'
import { lint as markdownlint } from 'markdownlint/sync'

export interface LintListItem {
  from: number
  line: number
  severity: Diagnostic['severity']
  message: string
  source: string | null
}

/** Subset of the public runtime config the story lint needs. */
export interface StoryLintLimits {
  content_story_title_max_length: number
  content_story_label_max_bytes: number
  content_story_desc_max_bytes: number
  content_story_cover_max_bytes: number
  content_story_markdown_max_bytes: number
}

export function story_lint_config(limits: StoryLintLimits, stories: ContentStorySummary[], story_id: number | null): ContentMarkdownConfig {
  return {
    title_max_length: limits.content_story_title_max_length,
    label_max_bytes: limits.content_story_label_max_bytes,
    desc_max_bytes: limits.content_story_desc_max_bytes,
    cover_max_bytes: limits.content_story_cover_max_bytes,
    markdown_max_bytes: limits.content_story_markdown_max_bytes,
    existing_titles: stories
      .filter(story => story.id !== story_id)
      .map(story => ({ id: story.id, title: story.title })),
  }
}

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

export function build_diagnostics(doc_text: string, doc: Text, content_markdown_config: ContentMarkdownConfig) {
  const diagnostics: Diagnostic[] = []

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

export function diagnostics_to_items(diagnostics: Diagnostic[], doc: Text): LintListItem[] {
  return diagnostics.map(diagnostic => ({
    from: diagnostic.from,
    line: doc.lineAt(diagnostic.from).number,
    severity: diagnostic.severity,
    message: diagnostic.message,
    source: diagnostic.source ?? null,
  }))
}

// Dispatched on an otherwise-no-op transaction when the known story list
// changes so the lint plugin re-schedules a run (its `force()` is a no-op
// while idle).
const stories_changed_effect = StateEffect.define<null>()

/**
 * The debounced lint extension. `get_config` is read on every run so the
 * diagnostics track the latest story list and limits; `on_issues` receives
 * the flattened list for the component's issue panel.
 */
export function create_markdown_lint(get_config: () => ContentMarkdownConfig, on_issues: (items: LintListItem[]) => void) {
  return linter((editor_view) => {
    const diagnostics = build_diagnostics(editor_view.state.doc.toString(), editor_view.state.doc, get_config())
    on_issues(diagnostics_to_items(diagnostics, editor_view.state.doc))
    return diagnostics
  }, {
    delay: 400,
    needsRefresh: update => update.transactions.some(tr => tr.effects.some(effect => effect.is(stories_changed_effect))),
  })
}

/**
 * Re-run duplicate-title / dead-reference lints when the story list changes
 * (e.g. after a sync refresh). `forceLinting` alone is a no-op while the
 * linter is idle, so first mark the linter dirty via `needsRefresh` (a
 * doc-change-free transaction), then force it.
 */
export function refresh_markdown_lint(view: EditorView) {
  view.dispatch({ effects: stories_changed_effect.of(null) })
  forceLinting(view)
}
