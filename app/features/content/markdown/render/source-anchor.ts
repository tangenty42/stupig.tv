import type MarkdownIt from 'markdown-it'
import type { RenderEnvironment, StoryMarkdownContext, StoryMarkdownPlugin } from './types'

/** Nested bodies share preview collections while suppressing shifted anchors. */
export function render_nested_markdown(md: MarkdownIt, ctx: StoryMarkdownContext, source: string, env: RenderEnvironment) {
  ctx.anchor_render_depth ++
  try {
    return md.render(source, env)
  }
  finally {
    ctx.anchor_render_depth --
  }
}

// VSCode-style source anchors: block elements carry their body line so the
// fullscreen editor's scroll sync can interpolate element-to-element. Nested
// renders (html wrappers re-rendering their inner markdown) report shifted
// line numbers, so only the top-level pass tags tokens.
export const source_anchor_plugin: StoryMarkdownPlugin = (md, ctx) => {
  md.core.ruler.push('source_line_anchor', (state) => {
    if (ctx.anchor_render_depth > 0) {
      return true
    }
    for (const token of state.tokens) {
      if (token.map) {
        token.attrJoin('data-line', String(token.map[0]))
      }
    }
    return true
  })
}
