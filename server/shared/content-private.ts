import type StateBlock from 'markdown-it/lib/rules_block/state_block.mjs'
import type StateInline from 'markdown-it/lib/rules_inline/state_inline.mjs'
import type { ContentMarkdownSource } from './content-markdown-source'
import MarkdownIt from 'markdown-it'
import { content_carousel_plugin, read_content_carousel_open } from './content-carousel'
import { content_markdown_fragment, content_markdown_source, content_markdown_token_body } from './content-markdown-source'
import { content_placeholder, CONTENT_PLACEHOLDER_TEXT } from './content-placeholder'

// Private (机密) content: a `<good>…</good>` element — block or inline —
// together with its children is visible only to users holding the
// content_private permission. These custom rules are registered BEFORE the
// built-in `html_block`/`html_inline` rules and claim the element as a
// first-class token. The block rule claims it when it spans several lines or
// IS its whole line; at a line start with trailing content, or mid-line,
// the inline rule claims it instead. The editor and the save path both lint
// unclosed tags, so stored content is well-formed; an unmatched open tag
// simply falls through to the built-in html handling (renders as plain text,
// no leak).

const private_open_pattern = /^<good\s*>/i

/** Finds the matching `</good>` from `from` on, counting `<good>` nesting. */
function find_private_close(src: string, from: number) {
  const boundary = /<carousel\b|<good\b[^>]*>|<\/good\s*>/gi
  boundary.lastIndex = from
  let depth = 1
  for (let match = boundary.exec(src); match !== null; match = boundary.exec(src)) {
    if (/^<carousel\b/i.test(match[0])) {
      const open = read_content_carousel_open(src, match.index)
      if (open)
        boundary.lastIndex = open.end
      continue
    }
    if (match[0].startsWith('</')) {
      depth --
    }
    else if (! match[0].endsWith('/>')) {
      depth ++
    }
    if (depth === 0) {
      return { start: match.index, end: match.index + match[0].length }
    }
  }
  return null
}

function content_private_block(state: StateBlock, startLine: number, endLine: number, silent: boolean) {
  // Indented code blocks win over private elements.
  if (state.sCount[startLine]! - state.blkIndent >= 4) {
    return false
  }
  const line_start = state.bMarks[startLine]! + state.tShift[startLine]!
  const line_end = state.eMarks[startLine]!
  const open = private_open_pattern.exec(state.src.slice(line_start, line_end))
  if (! open) {
    return false
  }
  const open_end = line_start + open[0].length
  const close = find_private_close(state.src, open_end)
  if (! close) {
    return false
  }
  // A single-line element is a block only when it is the whole line; with
  // trailing content it is inline, so the block rule steps aside.
  if (close.end <= line_end && state.src.slice(close.end, line_end).trim()) {
    return false
  }
  if (silent) {
    return true
  }
  // The whole element consumes full lines, like the built-in html block: from
  // the open tag's line through the line the close tag lands on.
  let last_line = startLine
  while (last_line < endLine && state.eMarks[last_line]! < close.end) {
    last_line ++
  }
  const token = state.push('content_private_block', '', 0)
  token.block = true
  token.map = [startLine, last_line + 1]
  token.content = state.src.slice(open_end, close.start)
  // The exact element source (open through close), so source-level stripping
  // can locate the range without absorbing trailing text.
  token.markup = state.src.slice(line_start, close.end)
  token.meta = { body_start: open_end, body_end: close.start, open_length: open[0].length }
  // Trailing text after the close tag is ordinary content, emitted as its own
  // paragraph — only the element's children belong inside the card.
  const trailing = state.src.slice(close.end, state.eMarks[last_line]!).trim()
  if (trailing) {
    const paragraph_open = state.push('paragraph_open', 'p', 1)
    paragraph_open.map = [last_line, last_line + 1]
    const inline = state.push('inline', '', 0)
    inline.content = trailing
    inline.map = [last_line, last_line + 1]
    inline.children = []
    state.push('paragraph_close', 'p', - 1)
  }
  state.line = last_line + 1
  return true
}

function content_private_inline(state: StateInline, silent: boolean) {
  const start = state.pos
  if (state.src.charCodeAt(start) !== 0x3C /* < */) {
    return false
  }
  const open = private_open_pattern.exec(state.src.slice(start, state.posMax))
  if (! open) {
    return false
  }
  const open_end = start + open[0].length
  const close = find_private_close(state.src, open_end)
  if (! close || close.end > state.posMax) {
    return false
  }
  if (! silent) {
    const token = state.push('content_private_inline', '', 0)
    token.content = state.src.slice(open_end, close.start)
    // The full matched source, so source-level stripping can locate it.
    token.markup = state.src.slice(start, close.end)
    token.meta = { body_start: open_end, body_end: close.start, open_length: open[0].length }
  }
  state.pos = close.end
  return true
}

/**
 * Tokenizer only — renderer rules are registered by the app-side preset, which
 * wraps the inner markdown in the private chrome. Rendering a token without a
 * rule falls back to markdown-it's token renderer, so server code must never
 * render with this plugin alone.
 */
export function content_private_plugin(md: MarkdownIt, interrupt_paragraph: boolean | (() => boolean) = false) {
  md.block.ruler.before('html_block', 'content_private_block', (state, start, end, silent) => {
    if (silent && typeof interrupt_paragraph === 'function' && ! interrupt_paragraph())
      return false
    return content_private_block(state, start, end, silent)
  }, { alt: interrupt_paragraph ? ['paragraph'] : [] })
  md.inline.ruler.before('html_inline', 'content_private_inline', content_private_inline)
}

// Private elements nested inside a raw html block (`<div>\n<good>…`) never
// reach the inline rule — markdown-it swallows the whole block as one opaque
// html_block token — so stripping must also scan those tokens raw.
const raw_open_scan = /<carousel\b|<good\s*>/gi

/** Pushes [start, end) ranges of private elements found in raw HTML text. */
function scan_raw_private_ranges(text: string, base: number, ranges: PrivateRange[]) {
  let found = false
  raw_open_scan.lastIndex = 0
  for (let match = raw_open_scan.exec(text); match !== null; match = raw_open_scan.exec(text)) {
    if (/^<carousel\b/i.test(match[0])) {
      const open = read_content_carousel_open(text, match.index)
      if (open)
        raw_open_scan.lastIndex = open.end
      continue
    }
    const close = find_private_close(text, match.index + match[0].length)
    if (! close) {
      continue
    }
    ranges.push({ from: base + match.index, to: base + close.end, block: false })
    found = true
    // Nested private elements are covered by the outer range.
    raw_open_scan.lastIndex = close.end
  }
  return found
}

/** Whether raw HTML text holds a private element (no ranges needed). */
function has_raw_private(text: string) {
  return scan_raw_private_ranges(text, 0, [])
}

interface PrivateRange {
  from: number
  to: number
  /** Block ranges cover whole lines and get the card placeholder. */
  block: boolean
}

/** The grayed-out text an unauthorized viewer sees in place of private content. */
export const CONTENT_PRIVATE_DENIED_TEXT = CONTENT_PLACEHOLDER_TEXT.private_denied

// What an unauthorized viewer sees in place of a private element: the shared
// content placeholder, so the layout hints that something exists here without
// leaking it. Rendered as raw HTML by the markdown pipeline.
export const CONTENT_PRIVATE_BLOCK_PLACEHOLDER = content_placeholder('denied', 'block', CONTENT_PRIVATE_DENIED_TEXT)
export const CONTENT_PRIVATE_INLINE_PLACEHOLDER = content_placeholder('denied', 'inline', CONTENT_PRIVATE_DENIED_TEXT)

// Cheap prescan so stories without the tag never pay for a tokenize.
const private_scan_pattern = /<good[\s>]/i

let strip_md: MarkdownIt | null = null
let carousel_strip_md: MarkdownIt | null = null

function get_strip_md(in_carousel: boolean) {
  if (in_carousel) {
    if (! carousel_strip_md) {
      carousel_strip_md = new MarkdownIt({ html: true, linkify: false })
      content_carousel_plugin(carousel_strip_md, true)
      // Carousel whitespace is only a separator; a private item can start
      // immediately after the previous link without an intervening blank line.
      content_private_plugin(carousel_strip_md, true)
    }
    return carousel_strip_md
  }
  if (! strip_md) {
    strip_md = new MarkdownIt({ html: true, linkify: false })
    // Malformed containers still have to expose their inner private elements
    // to the redactor; rendering continues to require the strict syntax.
    content_carousel_plugin(strip_md, true)
    content_private_plugin(strip_md)
  }
  return strip_md
}

interface PrivateTokenLike {
  type: string
  map: [number, number] | null
  content: string
  markup: string
  children: PrivateTokenLike[] | null
  meta?: { body_start: number, body_end: number, open_length: number } | null
}

function collect_private_tokens(markdown: string, in_carousel = false) {
  if (! private_scan_pattern.test(markdown)) {
    return null
  }
  const tokens = get_strip_md(in_carousel).parse(markdown, {}) as unknown as PrivateTokenLike[]
  return tokens
}

/** Depth-first: private elements also hide in image captions and link labels. */
function has_private_inline(children: PrivateTokenLike[]): boolean {
  return children.some(child =>
    child.type === 'content_private_inline'
    || (child.type === 'content_carousel_inline' && has_private_source(child.content, true))
    || (child.children !== null && has_private_inline(child.children)))
}

export function has_private_content(markdown: string): boolean {
  return has_private_source(markdown)
}

function has_private_source(markdown: string, in_carousel = false): boolean {
  const tokens = collect_private_tokens(markdown, in_carousel)
  if (! tokens) {
    return false
  }
  return tokens.some(token =>
    token.type === 'content_private_block'
    || (['content_carousel_block', 'content_carousel_inline'].includes(token.type) && has_private_source(token.content, true))
    || (token.type === 'inline' && has_private_inline(token.children ?? []))
    || (token.type === 'html_block' && has_raw_private(token.content)))
}

/**
 * Replaces every private element (block and inline) with a gray "no access"
 * placeholder. The result is what a viewer without the content_private
 * permission gets: the private source never leaves the server.
 */
export function redact_private_content(markdown: string): string {
  return private_representation(markdown, false).markdown
}

/** Editor previews retain source anchors while showing exactly the public body. */
export function redact_private_content_with_source_map(markdown: string) {
  return private_representation(markdown, true)
}

function private_content_ranges(markdown: string, in_carousel = false) {
  const ranges: PrivateRange[] = []
  const walk = (current: ContentMarkdownSource, children: PrivateTokenLike[]) => {
    let cursor = 0
    for (const child of children) {
      if (['content_private_inline', 'content_carousel_inline'].includes(child.type)) {
        const body = content_markdown_token_body(current, child, cursor)
        if (child.type === 'content_private_inline')
          ranges.push({ from: body.open_from, to: body.close_to, block: false })
        else
          scan(body.source, true)
        cursor = body.end
      }
      else if (child.children && child.content) {
        const at = current.text.indexOf(child.content, cursor)
        if (at >= 0)
          walk(content_markdown_fragment(current, child.content, at), child.children)
      }
      else if (child.type === 'html_inline') {
        const at = current.text.indexOf(child.content, cursor)
        if (at >= 0)
          cursor = at + child.content.length
      }
    }
  }
  function scan(current: ContentMarkdownSource, carousel: boolean) {
    const starts = [0]
    for (let index = 0; index < current.text.length; index ++) {
      if (current.text[index] === '\n')
        starts.push(index + 1)
    }
    for (const token of collect_private_tokens(current.text, carousel) ?? []) {
      if (! token.map)
        continue
      const start = starts[token.map[0]]!
      if (['content_carousel_block', 'content_private_block'].includes(token.type)) {
        const body = content_markdown_token_body(current, token, start)
        if (token.type === 'content_private_block')
          ranges.push({ from: body.open_from, to: body.close_to, block: true })
        else
          scan(body.source, true)
      }
      else if (token.type === 'html_block') {
        const block = content_markdown_fragment(current, token.content, start)
        const raw: PrivateRange[] = []
        scan_raw_private_ranges(token.content, 0, raw)
        for (const range of raw)
          ranges.push({ from: block.offsets[range.from]!, to: block.offsets[range.to]!, block: false })
      }
      else if (token.type === 'inline') {
        walk(content_markdown_fragment(current, token.content, start), token.children ?? [])
      }
    }
  }
  scan(content_markdown_source(markdown), in_carousel)
  return ranges
}

function private_representation(markdown: string, map_source: boolean): { markdown: string, source_lines?: number[] } {
  if (! private_scan_pattern.test(markdown)) {
    return { markdown }
  }
  const ranges = private_content_ranges(markdown)
  if (! ranges.length) {
    return { markdown }
  }

  ranges.sort((a, b) => a.from - b.from)
  let out = ''
  let pos = 0
  let original_line = 0
  const source_lines = map_source ? [0] : undefined
  const append = (text: string) => {
    out += text
    if (source_lines) {
      for (const character of text) {
        if (character === '\n')
          source_lines.push(++ original_line)
      }
    }
  }
  for (const range of ranges) {
    // Nested private elements fall inside an already-handled outer range.
    if (range.from < pos) {
      continue
    }
    append(markdown.slice(pos, range.from))
    out += range.block ? CONTENT_PRIVATE_BLOCK_PLACEHOLDER : CONTENT_PRIVATE_INLINE_PLACEHOLDER
    if (source_lines) {
      for (let index = range.from; index < range.to; index ++) {
        if (markdown[index] === '\n')
          original_line ++
      }
    }
    pos = range.to
    // The placeholder must own its line: if the close tag was followed by
    // trailing text rather than a newline, hand the line break over so the
    // remainder is not merged into the placeholder's html block.
    if (range.block && pos < markdown.length && markdown[pos] !== '\n') {
      out += '\n'
      source_lines?.push(original_line)
    }
  }
  append(markdown.slice(pos))
  source_lines?.push(original_line + 1)
  return { markdown: out, ... (source_lines ? { source_lines } : {}) }
}
