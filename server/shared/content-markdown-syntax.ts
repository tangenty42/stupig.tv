import type { ContentMarkdownSource } from './content-markdown-source'
import MarkdownIt from 'markdown-it'

import multimd_table from 'markdown-it-multimd-table'
import { content_carousel_plugin } from './content-carousel'
import { html_no_markdown_tags, html_table_tags } from './content-html'
import { content_markdown_fragment, content_markdown_source, content_markdown_token_body } from './content-markdown-source'
import { content_private_plugin } from './content-private'

export { content_carousel_plugin } from './content-carousel'

export function create_content_markdown_parser() {
  return new MarkdownIt({ html: true, linkify: false })
    .use(content_carousel_plugin)
    // Caption-derived IDs can be empty for CJK captions.
    .use(multimd_table, { rowspan: true, autolabel: false })
}

// HTML wrappers that are allowed to contain markdown: every element except
// raw-text/code/embedded ones (see features/content/markdown/html).

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

export function split_html_wrappers(content: string): HtmlWrapperChunk[] | null {
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
export function dedent_html_inner(text: string) {
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

/** Complete carousel bodies, mapped back through HTML wrappers and Markdown containers. */
export function content_carousel_content_ranges(source: string, env: object = {}) {
  const ranges: { from: number, to: number, content: string, offsets: number[] }[] = []
  const md = create_content_markdown_parser().use(content_private_plugin)
  const container = (current: ContentMarkdownSource, token: ReturnType<typeof md.parse>[number], start = 0) => {
    const body = content_markdown_token_body(current, token, start)
    if (token.type.startsWith('content_carousel'))
      ranges.push({ from: body.from, to: body.to, content: token.content, offsets: body.source.offsets })
    scan(body.source)
    return body.end
  }
  const inline = (current: ContentMarkdownSource, children: ReturnType<typeof md.parse>) => {
    let cursor = 0
    for (const child of children) {
      if (['content_carousel_inline', 'content_private_inline'].includes(child.type)) {
        cursor = container(current, child, cursor)
      }
      else if (child.children && child.content) {
        const at = current.text.indexOf(child.content, cursor)
        if (at >= 0)
          inline(content_markdown_fragment(current, child.content, at), child.children)
      }
      else if (child.type === 'html_inline') {
        const at = current.text.indexOf(child.content, cursor)
        if (at >= 0)
          cursor = at + child.content.length
      }
    }
  }
  function scan(current: ContentMarkdownSource) {
    const starts = [0]
    for (let index = 0; index < current.text.length; index ++) {
      if (current.text[index] === '\n')
        starts.push(index + 1)
    }
    for (const token of md.parse(current.text, env)) {
      if (! token.map)
        continue
      if (token.type === 'content_carousel_block') {
        container(current, token, starts[token.map[0]])
      }
      else if (token.type === 'content_private_block') {
        container(current, token, starts[token.map[0]])
      }
      else if (token.type === 'inline') {
        inline(content_markdown_fragment(current, token.content, starts[token.map[0]]), token.children ?? [])
      }
      else if (token.type === 'html_block') {
        const block = content_markdown_fragment(current, token.content, starts[token.map[0]]!)
        let cursor = 0
        for (const chunk of split_html_wrappers(block.text) ?? []) {
          const at = block.text.indexOf(chunk.source, cursor)
          cursor = at + chunk.source.length
          if (! chunk.closed || html_no_markdown_tags.has(chunk.tag) || html_table_tags.has(chunk.tag))
            continue
          scan(content_markdown_fragment(block, dedent_html_inner(chunk.inner), at + chunk.source.indexOf('>') + 1))
        }
      }
    }
  }
  scan(content_markdown_source(source))
  return ranges
}
