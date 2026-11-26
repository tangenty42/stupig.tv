import type { StoryMarkdownPlugin } from './types'
import { content_private_plugin } from '@shared/content-private'
import { private_content_brand } from './attachment-brand'
import { render_nested_markdown } from './source-anchor'

// The server substitutes placeholders before serving private Markdown to
// viewers without access. Render the full content beneath its privacy label.
export const private_blocks_plugin: StoryMarkdownPlugin = (md, ctx) => {
  content_private_plugin(md, () => ctx.carousel_render_depth > 0)

  md.renderer.rules.content_private_block = (tokens, idx, _options, env) => {
    const token = tokens[idx]!
    const line = token.attrGet('data-line')
    const line_attr = line === null ? '' : ` data-line="${line}"`
    // Same env as html wrappers: nested images/cards feed the lightbox.
    const inner = render_nested_markdown(md, ctx, token.content, env)
    return `<div class="private-block"${line_attr}>${private_content_brand}<div class="private-content-body">${inner}</div></div>\n`
  }

  md.renderer.rules.content_private_inline = (tokens, idx, _options, env) => {
    return `<span class="private-inline">${private_content_brand}<span class="private-content-body">${md.renderInline(tokens[idx]!.content, env)}</span></span>`
  }
}
