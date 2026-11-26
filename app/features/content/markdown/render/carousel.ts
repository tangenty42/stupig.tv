import type Token from 'markdown-it/lib/token.mjs'
import type { StoryMarkdownPlugin } from './types'
import { html_void_tags } from '@shared/content-html'
import { CONTENT_PRIVATE_BLOCK_PLACEHOLDER, CONTENT_PRIVATE_INLINE_PLACEHOLDER } from '@shared/content-private'
import { sanitize_story_html } from './sanitize'

interface InlineUnit { tokens: Token[], media: boolean, whitespace: boolean }

/** Raw HTML wrappers stay intact instead of splitting their children into cards. */
function update_html_stack(token: Token, stack: string[]) {
  const sources = token.type === 'inline' ? token.children ?? [] : [token]
  for (const source of sources) {
    if (! ['html_inline', 'html_block'].includes(source.type))
      continue
    for (const match of source.content.matchAll(/<!--[\s\S]*?-->|<(\/?)([a-z][\w-]*)\b[^>]*>/gi)) {
      if (! match[2])
        continue
      const tag = match[2].toLowerCase()
      if (match[1]) {
        const opening = stack.lastIndexOf(tag)
        if (opening !== - 1)
          stack.splice(opening)
      }
      else if (! html_void_tags.has(tag) && ! match[0].endsWith('/>')) {
        stack.push(tag)
      }
    }
  }
}

function inline_units(tokens: Token[]) {
  const units: InlineUnit[] = []
  for (let from = 0; from < tokens.length;) {
    const first = tokens[from]!
    if (first.type === 'text') {
      const leading = /^[\t ]*/.exec(first.content)![0].length
      const trailing = /[\t ]*$/.exec(first.content)![0].length
      const middle_end = Math.max(leading, first.content.length - trailing)
      for (const [content, whitespace] of [[first.content.slice(0, leading), true], [first.content.slice(leading, middle_end), false], [first.content.slice(middle_end), true]] as const) {
        if (content)
          units.push({ tokens: [Object.assign(Object.create(Object.getPrototypeOf(first)), first, { content })], media: false, whitespace })
      }
      from ++
      continue
    }
    let to = from + 1
    if (first.nesting === 1) {
      let depth = 1
      while (to < tokens.length && depth)
        depth += tokens[to ++]!.nesting
    }
    else if (first.type === 'html_inline') {
      const stack: string[] = []
      update_html_stack(first, stack)
      while (to < tokens.length && stack.length)
        update_html_stack(tokens[to ++]!, stack)
    }
    const placeholder = first.type === 'html_inline' && /^<(?:span|div) class="content-placeholder /.test(first.content)
    units.push({
      tokens: tokens.slice(from, to),
      media: ['image', 'link_open', 'content_private_inline', 'content_carousel_inline'].includes(first.type) || placeholder,
      whitespace: ['softbreak', 'hardbreak'].includes(first.type),
    })
    from = to
  }
  return units
}

// Only an explicit carousel block creates a strip. Its contents use the same
// Markdown parser, renderers, image collection and sanitization as the body.
export const carousel_plugin: StoryMarkdownPlugin = (md, ctx) => {
  const space = '<span class="carousel-space" aria-hidden="true"> </span>'
  const shell_attributes = (token: Token, inline: boolean) => {
    const classes = ['carousel-shell', inline && 'carousel-shell-inline', token.attrGet('class')].filter(Boolean).join(' ')
    // These attributes track the rendered source and controller state.
    const attrs = token.attrs?.filter(([name]) => ! ['class', 'data-line', 'data-wired'].includes(name)) ?? []
    const authored = attrs.map(([name, value]) => ` ${md.utils.escapeHtml(name)}="${md.utils.escapeHtml(value)}"`).join('')
    return ` class="${md.utils.escapeHtml(classes)}"${authored}`
  }
  const open_shell = (tag: string, attrs: string, line: string) => `<${tag}${attrs}><button type="button" class="carousel-nav carousel-prev" aria-label="上一项"><span class="iconify i-lucide:chevron-left" aria-hidden="true"></span></button><${tag} class="image-carousel"${line}>`
  const close_shell = (tag: string, end_line?: number) => {
    const anchor = end_line !== undefined && ctx.anchor_render_depth === 0
      ? `<span class="carousel-end-anchor" data-line="${end_line}" aria-hidden="true"></span>`
      : ''
    return `</${tag}><button type="button" class="carousel-nav carousel-next" aria-label="下一项"><span class="carousel-hint-text" aria-hidden="true"><span>右边还有！</span><span class="carousel-hint-detail">可左右滚动</span></span><span class="iconify i-lucide:chevron-right" aria-hidden="true"></span></button>${anchor}</${tag}>`
  }
  md.renderer.rules.content_carousel_inline = md.renderer.rules.content_carousel_block = (tokens, index, options, env, self) => {
    const token = tokens[index]!
    const inline = token.type === 'content_carousel_inline'
    let body = ''
    let pending_space = false
    const append = (html: string, wrapper?: 'span' | 'div') => {
      const content = sanitize_story_html(html)
      if (! content.trim())
        return
      if (pending_space && body)
        body += space
      body += wrapper ? `<${wrapper} class="carousel-content-item">${content}</${wrapper}>` : content
      pending_space = false
    }
    const paragraph = (children: Token[]) => {
      let prose: InlineUnit[] = []
      const flush_prose = () => {
        let from = 0
        let to = prose.length
        while (from < to && prose[from]!.whitespace)
          from ++
        while (to > from && prose[to - 1]!.whitespace)
          to --
        if (from)
          pending_space = Boolean(body)
        if (to > from)
          append(self.renderInline(prose.slice(from, to).flatMap(unit => unit.tokens), options, env), 'span')
        if (to < prose.length)
          pending_space = Boolean(body)
        prose = []
      }
      for (const unit of inline_units(children)) {
        if (! unit.media) {
          prose.push(unit)
          continue
        }
        flush_prose()
        append(self.renderInline(unit.tokens, options, env))
      }
      flush_prose()
    }
    const render_blocks = () => {
      const blocks = md.parse(token.content, env)
      for (let from = 0; from < blocks.length;) {
        const first = blocks[from]!
        if (body)
          pending_space = true
        const projected = first.type === 'html_block'
          ? [CONTENT_PRIVATE_BLOCK_PLACEHOLDER, CONTENT_PRIVATE_INLINE_PLACEHOLDER].find(placeholder => first.content.startsWith(placeholder))
          : undefined
        if (projected && first.content.slice(projected.length).trim()) {
          // A raw block placeholder can make CommonMark absorb the following
          // public Markdown until a blank line. Keep the projected item intact
          // and parse the remaining public source through the normal rules.
          append(projected)
          blocks.splice(from, 1, ... md.parse(first.content.slice(projected.length), env))
          continue
        }
        if (first.type === 'paragraph_open' && blocks[from + 1]?.type === 'inline' && blocks[from + 2]?.type === 'paragraph_close') {
          paragraph(blocks[from + 1]!.children ?? [])
          from += 3
          continue
        }
        let to = from + 1
        if (first.nesting === 1) {
          let depth = 1
          while (to < blocks.length && depth)
            depth += blocks[to ++]!.nesting
        }
        else if (first.type === 'html_block') {
          const stack: string[] = []
          update_html_stack(first, stack)
          while (to < blocks.length && stack.length)
            update_html_stack(blocks[to ++]!, stack)
        }
        const placeholder = first.type === 'html_block' && /^<(?:span|div) class="content-placeholder /.test(first.content)
        append(self.render(blocks.slice(from, to), options, env), placeholder ? undefined : 'div')
        from = to
      }
    }
    ctx.anchor_render_depth ++
    ctx.carousel_render_depth ++
    try {
      if (inline)
        paragraph(md.parseInline(token.content, env)[0]?.children ?? [])
      else
        render_blocks()
    }
    finally {
      ctx.carousel_render_depth --
      ctx.anchor_render_depth --
    }
    const tag = inline ? 'span' : 'div'
    const line = ! inline && token.map && ctx.anchor_render_depth === 0 ? ` data-line="${token.map[0]}"` : ''
    return `${open_shell(tag, shell_attributes(token, inline), line)}${body}${close_shell(tag, token.map?.[1])}${inline ? '' : '\n'}`
  }
}
