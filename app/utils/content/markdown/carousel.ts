import type { StoryMarkdownPlugin } from './types'
import { html_void_tags } from '@shared/content-html'
import { is_reference_card } from './link-cards'

// Consecutive images/cards share a scroll strip; surrounding prose keeps its
// normal flow. Each element renders identically inside or outside that strip.
export const carousel_plugin: StoryMarkdownPlugin = (md, ctx) => {
  md.core.ruler.after('inline', 'image_carousels', (state) => {
    type Token = InstanceType<typeof state.Token>
    const whitespace = (token: Token) => ['softbreak', 'hardbreak'].includes(token.type) || (token.type === 'text' && ! token.content.trim())
    const nesting = (token: Token) => {
      if (token.type !== 'html_inline')
        return token.nesting
      const tag = /^<(\/?)([a-z][\w-]*)\b[^>]*?(\/?)>$/i.exec(token.content)
      return ! tag || tag[3] || html_void_tags.has(tag[2]!.toLowerCase()) ? 0 : tag[1] ? - 1 : 1
    }
    const clone = (token: Token) => Object.assign(new state.Token(token.type, token.tag, token.nesting), token, {
      attrs: token.attrs?.map(attribute => [... attribute]) ?? null,
    })
    for (let index = 0; index < state.tokens.length - 2;) {
      const opening = state.tokens[index]!
      const inline = state.tokens[index + 1]!
      const closing = state.tokens[index + 2]!
      if (opening.type !== 'paragraph_open' || inline.type !== 'inline' || closing.type !== 'paragraph_close') {
        index ++
        continue
      }
      const children = inline.children ?? []
      const units: { children: Token[], media: boolean, whitespace: boolean }[] = []
      for (let position = 0; position < children.length;) {
        const first = children[position]!
        let end = position + 1
        // Never cut an emphasis, link label or raw inline HTML container in half.
        if (nesting(first) === 1) {
          let depth = 1
          while (end < children.length && depth > 0)
            depth += nesting(children[end ++]!)
        }
        units.push({ children: children.slice(position, end), media: first.type === 'image' || is_reference_card(children, position, ctx.options), whitespace: whitespace(first) })
        position = end
      }
      const segments: { carousel: boolean, children: Token[] }[] = []
      let normal_start = 0
      for (let position = 0; position < units.length;) {
        if (! units[position]!.media) {
          position ++
          continue
        }
        let end = position + 1
        let count = 1
        for (let next = end; next < units.length;) {
          while (units[next]?.whitespace)
            next ++
          if (! units[next]?.media)
            break
          end = next + 1
          count ++
          next = end
        }
        const standalone = units.slice(0, position).every(unit => unit.whitespace) && units.slice(end).every(unit => unit.whitespace)
        if (count < 2 && ! standalone) {
          position = end
          continue
        }
        const before = units.slice(normal_start, position).flatMap(unit => unit.children)
        while (before.length && whitespace(before.at(- 1)!))
          before.pop()
        if (before.length)
          segments.push({ carousel: false, children: before })
        segments.push({ carousel: true, children: units.slice(position, end).filter(unit => unit.media).flatMap(unit => unit.children) })
        normal_start = end
        while (units[normal_start]?.whitespace)
          normal_start ++
        position = normal_start
      }
      if (! segments.length) {
        index += 3
        continue
      }
      const after = units.slice(normal_start).flatMap(unit => unit.children)
      if (after.length)
        segments.push({ carousel: false, children: after })
      const replacement = segments.flatMap((segment) => {
        const start = clone(opening)
        const content = clone(inline)
        const end = clone(closing)
        content.children = segment.children
        if (segment.carousel) {
          start.attrJoin('class', 'image-carousel')
          start.meta = { ... start.meta, carousel: true }
          end.meta = { ... end.meta, carousel: true }
        }
        return [start, content, end]
      })
      state.tokens.splice(index, 3, ... replacement)
      index += replacement.length
    }
  })

  // Hoist the carousel into a .carousel-shell <div> with the two nav
  // buttons; the scroll strip keeps the .image-carousel class and behavior.
  md.renderer.rules.paragraph_open = (tokens, idx, options, env, self) => {
    const token = tokens[idx]!
    if (token.meta?.carousel) {
      return `<div class="carousel-shell"><button type="button" class="carousel-nav carousel-prev" aria-label="上一张"><span class="iconify i-lucide:chevron-left" aria-hidden="true"></span></button><div${self.renderAttrs(token)}>`
    }
    return self.renderToken(tokens, idx, options)
  }

  md.renderer.rules.paragraph_close = (tokens, idx, options, env, self) => {
    const token = tokens[idx]!
    if (token.meta?.carousel) {
      // End anchor: the scroll sync interpolates element-to-element, so the
      // strip anchors its bottom edge to the line right after it (the map's
      // exclusive end) — using the last carousel line would share the head's
      // line for one-line strips and pin the editor there. Same top-level
      // guard as source-anchor; the map lives on the opening token
      // (paragraph_close has none).
      const opening = tokens[idx - 2]
      const map = opening?.type === 'paragraph_open' ? opening.map : null
      const end_anchor = map && ctx.anchor_render_depth === 0
        ? `<span class="carousel-end-anchor" data-line="${map[1]}" aria-hidden="true"></span>`
        : ''
      return `</div><button type="button" class="carousel-nav carousel-next" aria-label="下一张"><span class="carousel-hint-text" aria-hidden="true">右边还有·可左右滚动</span><span class="iconify i-lucide:chevron-right" aria-hidden="true"></span></button>${end_anchor}</div>\n`
    }
    return self.renderToken(tokens, idx, options)
  }
}
