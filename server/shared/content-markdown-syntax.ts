import MarkdownIt from 'markdown-it'
import multimd_table from 'markdown-it-multimd-table'

export function create_content_markdown_parser() {
  return new MarkdownIt({ html: true, linkify: false })
    // Caption-derived IDs can be empty for CJK captions.
    .use(multimd_table, { rowspan: true, autolabel: false })
}

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
