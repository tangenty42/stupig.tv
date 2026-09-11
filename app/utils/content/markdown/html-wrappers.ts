import type { StoryMarkdownPlugin } from './types'
import { html_no_markdown_tags, html_table_tags } from '~/utils/content/html'

// HTML wrappers that are allowed to contain markdown: every element except
// raw-text/code/embedded ones (see utils/content/html).

// A wrapper whose content is entirely markdown (no blank lines, or the block
// parser would have split it) arrives as one html_block token — but one token
// can also glue several SIBLING elements together (e.g. two `<center>` lines
// with no blank line between them), so it must be split into complete
// top-level elements with same-tag nesting matched. A single lazy
// `<tag>...</tag>` match would span siblings and strand their close tags.
const html_element_open_pattern = /^<([a-z][\w-]*)\b([^>]*?)(\/?)>/i

interface HtmlWrapperChunk {
  tag: string
  attrs: string
  inner: string
  /** Exact source text of the whole element, for raw passthrough. */
  source: string
  closed: boolean
}

function split_html_wrappers(content: string): HtmlWrapperChunk[] | null {
  const chunks: HtmlWrapperChunk[] = []
  let rest = content
  while (rest.trim()) {
    rest = rest.replace(/^\s+/, '')
    const open = html_element_open_pattern.exec(rest)
    if (! open) {
      return null
    }
    const tag = open[1]!.toLowerCase()
    if (open[3]) { // self-closing: nothing to parse inside
      chunks.push({ tag, attrs: '', inner: '', source: open[0], closed: false })
      rest = rest.slice(open[0].length)
      continue
    }
    const boundary = new RegExp(String.raw`<${tag}\b[^>]*>|<\/${tag}\s*>`, 'gi')
    boundary.lastIndex = open[0].length
    let depth = 1
    let close: RegExpExecArray | null = null
    for (let match = boundary.exec(rest); match !== null; match = boundary.exec(rest)) {
      if (match[0].startsWith('</')) {
        depth --
      }
      else if (! match[0].endsWith('/>')) {
        depth ++
      }
      if (depth === 0) {
        close = match
        break
      }
    }
    if (! close) {
      return null
    }
    const end = close.index + close[0].length
    chunks.push({ tag, attrs: open[2]!, inner: rest.slice(open[0].length, close.index), source: rest.slice(0, end), closed: true })
    rest = rest.slice(end)
  }
  return chunks
}

// HTML wrapper indentation is cosmetic whitespace, not markdown structure.
// Without this, `    [](tmp.jpg)` inside a wrapper would parse as an indented
// code block instead of a link/file card.
function dedent_html_inner(text: string) {
  const lines = text.split('\n')
  let min_indent = Infinity
  for (const line of lines) {
    if (! line.trim()) {
      continue
    }
    const leading = /^[ \t]*/.exec(line)![0].length
    min_indent = Math.min(min_indent, leading)
  }
  if (! Number.isFinite(min_indent) || min_indent === 0) {
    return text.trim()
  }
  return lines.map(line => line.slice(min_indent)).join('\n').trim()
}

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
      ctx.anchor_render_depth ++
      try {
        const inner_html = md.render(dedent_html_inner(chunk.inner), env)
        return `<${chunk.tag}${chunk.attrs}${line_attr}>${inner_html}</${chunk.tag}>`
      }
      finally {
        ctx.anchor_render_depth --
      }
    }).join('\n')}\n`
  }
}
