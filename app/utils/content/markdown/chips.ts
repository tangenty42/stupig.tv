import type { StoryMarkdownPlugin } from './types'

interface ChipToken {
  type: string
  attrJoin: (name: string, value: string) => void
}

// Inline chips (inline code, file cards) get side margins to separate them
// from neighboring text, but at a line edge the margin would break the
// text's left/right alignment, so skip it when the chip is the first/last
// inline content of a line. Only hard breaks count: a softbreak renders as
// a space, so a chip after one is still mid-line. Link boundaries are
// transparent: a link starting with a chip still counts as a line edge.
// Each chip type gets its own class pair (chip-code-gap-l, chip-card-gap-l,
// ...) so their styles can be tuned independently.
function at_line_edge(sibling?: { type: string }) {
  return ! sibling || ['hardbreak', 'link_open', 'link_close'].includes(sibling.type)
}

export function apply_chip_gaps(token: ChipToken, tokens: ChipToken[], idx: number, end_idx = idx, type = 'code') {
  if (! at_line_edge(tokens[idx - 1])) {
    token.attrJoin('class', `chip-${type}-gap-l`)
  }
  if (! at_line_edge(tokens[end_idx + 1])) {
    token.attrJoin('class', `chip-${type}-gap-r`)
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
