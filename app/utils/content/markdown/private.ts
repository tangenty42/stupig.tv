import type { StoryMarkdownPlugin } from './types'
import { CONTENT_PRIVATE_INLINE_PLACEHOLDER, content_private_plugin } from '@shared/content-private'
import { chip_gap_classes } from './chips'

// Private (机密) elements: the shared module tokenizes them (rules registered
// before markdown-it's html rules so `good`-tagged elements win); here
// they get their chrome — a dashed lock card for blocks, a dashed lock span
// inline. Viewers without the permission never receive the private source at
// all (the server swaps in a gray placeholder), so no hidden-state rendering
// is needed.
export const private_blocks_plugin: StoryMarkdownPlugin = (md, ctx) => {
  content_private_plugin(md)

  md.renderer.rules.content_private_block = (tokens, idx, _options, env) => {
    const token = tokens[idx]!
    const line_attr = token.map ? ` data-line="${token.map[0]}"` : ''
    // Same env as html wrappers: nested images/cards feed the lightbox.
    ctx.anchor_render_depth ++
    try {
      const inner = md.render(token.content, env)
      return `<div class="private-block"${line_attr}><div class="private-block-brand"><span class="iconify i-lucide:lock-keyhole-open" aria-hidden="true"></span><span class="private-block-brand-text">机密内容</span></div><div class="private-block-body">${inner}</div></div>\n`
    }
    finally {
      ctx.anchor_render_depth --
    }
  }

  md.renderer.rules.content_private_inline = (tokens, idx, _options, env) => {
    const gaps = chip_gap_classes(tokens, idx, idx, 'card')
    const gap_class = gaps.length ? ` ${gaps.join(' ')}` : ''
    return `<span class="private-inline${gap_class}"><span class="iconify i-lucide:lock-keyhole-open private-inline-icon" aria-hidden="true"></span><span class="private-inline-tag">机密内容</span>${md.renderInline(tokens[idx]!.content, env)}</span>`
  }

  // The denied placeholder arrives as raw html_inline (the server swapped it
  // into the markdown); give it the same card gaps as a real private chip.
  const denied_open_tag = CONTENT_PRIVATE_INLINE_PLACEHOLDER.slice(0, CONTENT_PRIVATE_INLINE_PLACEHOLDER.indexOf('>') + 1)
  const default_html_inline = md.renderer.rules.html_inline
    ?? ((tokens, idx) => tokens[idx]!.content)
  md.renderer.rules.html_inline = (tokens, idx, options, env, self) => {
    const html = default_html_inline(tokens, idx, options, env, self)
    if (! html.startsWith(denied_open_tag)) {
      return html
    }
    const gaps = chip_gap_classes(tokens, idx, idx, 'card')
    if (! gaps.length) {
      return html
    }
    const tagged = denied_open_tag.replace(/">$/, ` ${gaps.join(' ')}">`)
    return tagged + html.slice(denied_open_tag.length)
  }
}
