import type StateBlock from 'markdown-it/lib/rules_block/state_block.mjs'
import type StateInline from 'markdown-it/lib/rules_inline/state_inline.mjs'
import MarkdownIt from 'markdown-it'

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
  const boundary = /<good\b[^>]*>|<\/good\s*>/gi
  boundary.lastIndex = from
  let depth = 1
  for (let match = boundary.exec(src); match !== null; match = boundary.exec(src)) {
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
export function content_private_plugin(md: MarkdownIt) {
  md.block.ruler.before('html_block', 'content_private_block', content_private_block, { alt: [] })
  md.inline.ruler.before('html_inline', 'content_private_inline', content_private_inline)
}

// Private elements nested inside a raw html block (`<div>\n<good>…`) never
// reach the inline rule — markdown-it swallows the whole block as one opaque
// html_block token — so stripping must also scan those tokens raw.
const raw_open_scan = /<good\s*>/gi

/** Pushes [start, end) ranges of private elements found in raw HTML text. */
function scan_raw_private_ranges(text: string, base: number, ranges: PrivateRange[]) {
  let found = false
  raw_open_scan.lastIndex = 0
  for (let match = raw_open_scan.exec(text); match !== null; match = raw_open_scan.exec(text)) {
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
export const CONTENT_PRIVATE_DENIED_TEXT = '你无权查看此机密内容'

// What an unauthorized viewer sees in place of a private element: the card is
// still rendered, grayed out, so the layout hints that something exists here
// without leaking it. Rendered as raw HTML by the markdown pipeline.
export const CONTENT_PRIVATE_BLOCK_PLACEHOLDER = `<div class="private-block-denied"><span class="iconify i-lucide:ban" aria-hidden="true"></span><span>${CONTENT_PRIVATE_DENIED_TEXT}</span></div>`
export const CONTENT_PRIVATE_INLINE_PLACEHOLDER = `<span class="private-inline-denied"><span class="iconify i-lucide:ban chip-icon" aria-hidden="true"></span>${CONTENT_PRIVATE_DENIED_TEXT}</span>`

// Cheap prescan so stories without the tag never pay for a tokenize.
const private_scan_pattern = /<good[\s>]/

let strip_md: MarkdownIt | null = null

function get_strip_md() {
  if (! strip_md) {
    strip_md = new MarkdownIt({ html: true, linkify: false })
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
}

function collect_private_tokens(markdown: string) {
  if (! private_scan_pattern.test(markdown)) {
    return null
  }
  const tokens = get_strip_md().parse(markdown, {}) as unknown as PrivateTokenLike[]
  return tokens
}

/** Depth-first: private elements also hide in image captions and link labels. */
function has_private_inline(children: PrivateTokenLike[]): boolean {
  return children.some(child =>
    child.type === 'content_private_inline'
    || (child.children !== null && has_private_inline(child.children)))
}

export function has_private_content(markdown: string): boolean {
  const tokens = collect_private_tokens(markdown)
  if (! tokens) {
    return false
  }
  return tokens.some(token =>
    token.type === 'content_private_block'
    || (token.type === 'inline' && has_private_inline(token.children ?? []))
    || (token.type === 'html_block' && has_raw_private(token.content)))
}

/**
 * Replaces every private element (block and inline) with a gray "no access"
 * placeholder. The result is what a viewer without the content_private
 * permission gets: the private source never leaves the server.
 */
export function redact_private_content(markdown: string): string {
  const tokens = collect_private_tokens(markdown)
  if (! tokens) {
    return markdown
  }
  const lines = markdown.split('\n')
  const line_starts: number[] = []
  let offset = 0
  for (const line of lines) {
    line_starts.push(offset)
    offset += line.length + 1
  }

  const ranges: PrivateRange[] = []
  for (const token of tokens) {
    if (token.type === 'content_private_block' && token.map) {
      // markup is the exact element source (open through close); the block's
      // line range would absorb trailing text on the close line.
      const indent = /^ */.exec(lines[token.map[0]]!)![0].length
      const from = line_starts[token.map[0]]! + indent
      ranges.push({ from, to: from + token.markup.length, block: true })
    }
    else if (token.type === 'html_block' && token.map) {
      // Raw html blocks never reach the inline rule; scan them textually.
      const indent = /^ */.exec(lines[token.map[0]]!)![0].length
      scan_raw_private_ranges(token.content, line_starts[token.map[0]]! + indent, ranges)
    }
    else if (token.type === 'inline' && token.map) {
      // Inline token content starts after the first line's (up to 3) indent.
      const indent = /^ */.exec(lines[token.map[0]]!)![0].length
      const base = line_starts[token.map[0]]! + indent
      let cursor = 0
      // Children are in source order, so one cursor stays monotonic even when
      // private elements hide inside image captions or link labels.
      const walk = (children: PrivateTokenLike[]) => {
        for (const child of children) {
          if (child.type === 'content_private_inline') {
            const at = token.content.indexOf(child.markup, cursor)
            if (at === - 1) {
              continue
            }
            ranges.push({ from: base + at, to: base + at + child.markup.length, block: false })
            cursor = at + child.markup.length
          }
          else if (child.children) {
            walk(child.children)
          }
        }
      }
      walk(token.children ?? [])
    }
  }
  if (! ranges.length) {
    return markdown
  }

  ranges.sort((a, b) => a.from - b.from)
  let out = ''
  let pos = 0
  for (const range of ranges) {
    // Nested private elements fall inside an already-handled outer range.
    if (range.from < pos) {
      continue
    }
    out += markdown.slice(pos, range.from)
    out += range.block ? CONTENT_PRIVATE_BLOCK_PLACEHOLDER : CONTENT_PRIVATE_INLINE_PLACEHOLDER
    pos = range.to
    // The placeholder must own its line: if the close tag was followed by
    // trailing text rather than a newline, hand the line break over so the
    // remainder is not merged into the placeholder's html block.
    if (range.block && pos < markdown.length && markdown[pos] !== '\n') {
      out += '\n'
    }
  }
  out += markdown.slice(pos)
  return out
}
