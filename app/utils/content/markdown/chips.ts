import type { StoryMarkdownPlugin } from './types'

interface ChipToken {
  type: string
  attrJoin: (name: string, value: string) => void
}

// Inline chips (inline code, plain links, file/video/story cards) get side
// margins to separate them from neighboring text, but at a line edge the
// margin would break the text's left/right alignment, so skip it when the
// chip is the first/last inline content of a line. Only hard breaks count: a
// softbreak renders as a space, so a chip after one is still mid-line. Link
// boundaries are transparent: a link starting with a chip still counts as a
// line edge.
// Inline code and the link-card chips (plain links and the reference cards,
// which share one chrome) get their own class pair — chip-code-gap-l,
// chip-card-gap-l, ... — so their styles can be tuned independently.
function at_line_edge(sibling?: { type: string }) {
  return ! sibling || ['hardbreak', 'link_open', 'link_close'].includes(sibling.type)
}

/** The gap classes a chip at [idx, end_idx] needs, empty at a line edge. */
export function chip_gap_classes(tokens: ChipToken[], idx: number, end_idx = idx, type = 'code') {
  const classes: string[] = []
  if (! at_line_edge(tokens[idx - 1])) {
    classes.push(`chip-${type}-gap-l`)
  }
  // A chip whose end the caller could not pin down (a link label carrying
  // markup has no plain text token to close on) falls back to its own index.
  const last = end_idx >= 0 ? end_idx : idx
  if (! at_line_edge(tokens[last + 1])) {
    classes.push(`chip-${type}-gap-r`)
  }
  return classes
}

export function apply_chip_gaps(token: ChipToken, tokens: ChipToken[], idx: number, end_idx = idx, type = 'code') {
  for (const gap_class of chip_gap_classes(tokens, idx, end_idx, type)) {
    token.attrJoin('class', gap_class)
  }
}

export const chips_plugin: StoryMarkdownPlugin = (md) => {
  const default_code_inline_rule = md.renderer.rules.code_inline
    ?? ((tokens, idx, _options, _env, self) => `<code${self.renderAttrs(tokens[idx]!)}>${md.utils.escapeHtml(tokens[idx]!.content)}</code>`)
  md.renderer.rules.code_inline = (tokens, idx, options, env, self) => {
    apply_chip_gaps(tokens[idx]!, tokens, idx)
    return default_code_inline_rule(tokens, idx, options, env, self)
  }
}
