import type { StoryMarkdownPlugin } from './types'
import { dedent_html_inner, split_html_wrappers } from '@shared/content-markdown-syntax'

import { html_no_markdown_tags, html_table_tags } from '~/utils/content/html'
import { render_nested_markdown } from './source-anchor'

export const html_wrappers_plugin: StoryMarkdownPlugin = (md, ctx) => {
  const default_html_block_rule = md.renderer.rules.html_block
    ?? ((tokens, idx) => tokens[idx]!.content)
  md.renderer.rules.html_block = (tokens, idx, options, env, self) => {
    const token = tokens[idx]!
    const chunks = split_html_wrappers(token.content)
    if (! chunks) {
      return default_html_block_rule(tokens, idx, options, env, self)
    }
    const line_attr = token.map ? ` data-line="${token.map[0]}"` : ''
    return `${chunks.map((chunk) => {
      if (! chunk.closed || html_no_markdown_tags.has(chunk.tag) || html_table_tags.has(chunk.tag)) {
        return chunk.source
      }
      // Reuse the same env so nested markdown (images, cards) feeds the
      // preview lightbox through the shared images array.
      const inner_html = render_nested_markdown(md, ctx, dedent_html_inner(chunk.inner), env)
      return `<${chunk.tag}${chunk.attrs}${line_attr}>${inner_html}</${chunk.tag}>`
    }).join('\n')}\n`
  }
}
