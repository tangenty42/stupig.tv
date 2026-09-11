import type { StoryMarkdownPlugin } from './types'

// Image carousels: a run of consecutive images in one paragraph becomes a
// horizontal scroll strip. The core rule splits mixed paragraphs into
// image-only and normal segments, tags the image-only ones as carousels,
// and the paragraph renderers hoist a carousel out of its <p> into a
// .carousel-shell <div> — a carousel can't stay a <p> because its prev/next
// buttons must be block-level siblings (interactive content isn't allowed
// inside a <p> anyway).
export const carousel_plugin: StoryMarkdownPlugin = (md, ctx) => {
  md.core.ruler.after('inline', 'image_carousels', (state) => {
    const is_break = (type: string) => type === 'softbreak' || type === 'hardbreak'
    const clone_token = (token: InstanceType<typeof state.Token>) => Object.assign(
      new state.Token(token.type, token.tag, token.nesting),
      token,
      { attrs: token.attrs?.map(attribute => [... attribute]) ?? null },
    )

    for (let index = 0; index < state.tokens.length - 2;) {
      const paragraph_open = state.tokens[index]
      const inline = state.tokens[index + 1]
      const paragraph_close = state.tokens[index + 2]
      const children = inline?.children ?? []
      const segments: { carousel: boolean, children: typeof children }[] = []
      let normal_start = 0

      if (paragraph_open?.type !== 'paragraph_open'
        || inline?.type !== 'inline'
        || paragraph_close?.type !== 'paragraph_close') {
        index ++
        continue
      }

      for (let child_index = 0; child_index < children.length;) {
        if (children[child_index]?.type !== 'image') {
          child_index ++
          continue
        }

        let run_end = child_index + 1
        let image_count = 1
        while (is_break(children[run_end]?.type ?? '') && children[run_end + 1]?.type === 'image') {
          run_end += 2
          image_count ++
        }

        if (image_count < 2) {
          child_index = run_end
          continue
        }

        const before = children.slice(normal_start, child_index)
        while (before.length && is_break(before.at(- 1)?.type ?? '')) {
          before.pop()
        }
        if (before.length) {
          segments.push({ carousel: false, children: before })
        }
        segments.push({
          carousel: true,
          children: children.slice(child_index, run_end).filter(child => child.type === 'image'),
        })

        normal_start = run_end
        while (is_break(children[normal_start]?.type ?? '')) {
          normal_start ++
        }
        child_index = normal_start
      }

      if (! segments.some(segment => segment.carousel)) {
        index += 3
        continue
      }

      const after = children.slice(normal_start)
      if (after.length) {
        segments.push({ carousel: false, children: after })
      }

      const replacement = segments.flatMap((segment) => {
        const opening = clone_token(paragraph_open)
        const content = clone_token(inline)
        const closing = clone_token(paragraph_close)
        content.children = segment.children
        return [opening, content, closing]
      })
      state.tokens.splice(index, 3, ... replacement)
      index += replacement.length
    }

    const image_paragraph_at = (index: number) => {
      const paragraph_open = state.tokens[index]
      const inline = state.tokens[index + 1]
      const paragraph_close = state.tokens[index + 2]
      const children = inline?.children ?? []
      const image_count = children.filter(child => child.type === 'image').length
      const is_image_only = image_count > 0
        && children.every(child => ['image', 'softbreak', 'hardbreak'].includes(child.type))

      return paragraph_open?.type === 'paragraph_open'
        && inline?.type === 'inline'
        && paragraph_close?.type === 'paragraph_close'
        && is_image_only
        ? { paragraph_open, inline, paragraph_close, image_count }
        : null
    }

    for (let index = 0; index < state.tokens.length - 2; index ++) {
      const paragraph = image_paragraph_at(index)
      if (! paragraph || paragraph.image_count < 1) {
        continue
      }

      paragraph.paragraph_open.attrJoin('class', 'image-carousel')
      paragraph.paragraph_open.meta = { ... paragraph.paragraph_open.meta, carousel: true }
      paragraph.paragraph_close.meta = { ... paragraph.paragraph_close.meta, carousel: true }
      for (const child of paragraph.inline.children ?? []) {
        if (is_break(child.type)) {
          child.type = 'text'
          child.content = ''
        }
        else if (child.type === 'image') {
          child.meta = { ... child.meta, carousel: true }
        }
      }
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
      return `</div><button type="button" class="carousel-nav carousel-next" aria-label="下一张"><span class="carousel-hint-text" aria-hidden="true">右边还有 · 可左右滚动</span><span class="iconify i-lucide:chevron-right" aria-hidden="true"></span></button>${end_anchor}</div>\n`
    }
    return self.renderToken(tokens, idx, options)
  }
}
