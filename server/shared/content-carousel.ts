import type MarkdownIt from 'markdown-it'
import type StateBlock from 'markdown-it/lib/rules_block/state_block.mjs'
import { unescapeAll } from 'markdown-it/lib/common/utils.mjs'
import { html_no_markdown_tags, html_table_tags, html_void_tags } from './content-html'

interface HtmlTag { name: string, end: number, closing: boolean, self_closing: boolean, attrs: [string, string][] }
export interface ContentCarouselMeta { body_start: number, body_end: number, open_length: number, closed: boolean }

function html_space(character: string | undefined) {
  return character !== undefined && /[\t\n\f\r ]/.test(character)
}

function read_html_tag(source: string, from: number): HtmlTag | null {
  const pattern = /<(\/?)([a-z][\w:-]*)/iy
  pattern.lastIndex = from
  const head = pattern.exec(source)
  if (! head)
    return null
  const closing = Boolean(head[1])
  const attrs: [string, string][] = []
  const names = new Set<string>()
  let cursor = from + head[0].length
  while (cursor < source.length) {
    const before_space = cursor
    while (html_space(source[cursor]))
      cursor ++
    if (source[cursor] === '>')
      return { name: head[2]!.toLowerCase(), end: cursor + 1, closing, self_closing: false, attrs }
    if (! closing && source[cursor] === '/' && source[cursor + 1] === '>')
      return { name: head[2]!.toLowerCase(), end: cursor + 2, closing, self_closing: true, attrs }
    if (closing || cursor === before_space)
      return null
    const name_start = cursor
    while (cursor < source.length && ! /[\t\n\f\r /="'<>`]/.test(source[cursor]!))
      cursor ++
    if (cursor === name_start)
      return null
    const name = source.slice(name_start, cursor).toLowerCase()
    const after_name = cursor
    while (html_space(source[cursor]))
      cursor ++
    let value = ''
    if (source[cursor] === '=') {
      cursor ++
      while (html_space(source[cursor]))
        cursor ++
      const quote = source[cursor]
      if (quote === '"' || quote === '\'') {
        const end = source.indexOf(quote, cursor + 1)
        if (end === - 1)
          return null
        value = source.slice(cursor + 1, end)
        cursor = end + 1
      }
      else {
        const start = cursor
        while (cursor < source.length && ! /[\t\n\f\r "'=<>`]/.test(source[cursor]!))
          cursor ++
        if (cursor === start)
          return null
        value = source.slice(start, cursor)
      }
    }
    else {
      cursor = after_name
    }
    if (! names.has(name)) {
      names.add(name)
      // HTML attributes retain literal backslashes; only entity matches go
      // through markdown-it's decoder, rather than its Markdown unescaping.
      attrs.push([name, value.replace(/&(?:#x[a-f\d]+|#\d+|[a-z][a-z\d]+);/gi, entity => unescapeAll(entity))])
    }
  }
  return null
}

export function read_content_carousel_open(source: string, from = 0) {
  const tag = read_html_tag(source, from)
  return tag?.name === 'carousel' && ! tag.closing && ! tag.self_closing ? { end: tag.end, attrs: tag.attrs } : null
}

function markdown_line_start(source: string, from: number, end: number) {
  let cursor = from
  let quotes = 0
  let list_width = 0
  while (cursor < end) {
    let columns = 0
    while (cursor < end && (source[cursor] === ' ' || source[cursor] === '\t')) {
      columns += source[cursor] === '\t' ? 4 - columns % 4 : 1
      cursor ++
    }
    if (columns >= 4)
      return { cursor, indented: true, indentation: columns, quotes, list_width }
    if (source[cursor] === '>') {
      quotes ++
      list_width = 0
      cursor ++
      if (source[cursor] === ' ' || source[cursor] === '\t')
        cursor ++
      continue
    }
    const list = /^(?:[-+*]|\d{1,9}[.)])[\t ]+/.exec(source.slice(cursor, end))
    if (! list)
      return { cursor, indented: false, indentation: columns, quotes, list_width }
    cursor += list[0].length
    list_width += columns + list[0].length
  }
  return { cursor, indented: false, indentation: 0, quotes, list_width }
}

/** Match actual tags while leaving Markdown code and raw-text HTML untouched. */
export function find_content_carousel_close(source: string, from: number, end = source.length) {
  let depth = 1
  let cursor = from
  let fence: { mark: string, length: number, quotes: number, list_width: number } | null = null
  while (cursor < end) {
    if (cursor === 0 || source[cursor - 1] === '\n') {
      const newline = source.indexOf('\n', cursor)
      const line_end = Math.min(end, newline === - 1 ? end : newline)
      const line = markdown_line_start(source, cursor, line_end)
      const boundary = /^(`{3,}|~{3,})/.exec(source.slice(line.cursor, line_end))
      if (fence) {
        const outdented = line.cursor < line_end && (line.quotes < fence.quotes || (! line.list_width && line.indentation < fence.list_width))
        if (outdented) {
          fence = null
        }
        else {
          if (boundary && ! line.list_width && line.quotes === fence.quotes && line.indentation - fence.list_width < 4 && boundary[1]![0] === fence.mark && boundary[1]!.length >= fence.length && ! source.slice(line.cursor + boundary[0].length, line_end).trim())
            fence = null
          cursor = line_end + 1
          continue
        }
      }
      if (line.indented) {
        cursor = line_end + 1
        continue
      }
      if (boundary && (boundary[1]![0] !== '`' || ! source.slice(line.cursor + boundary[0].length, line_end).includes('`'))) {
        fence = { mark: boundary[1]![0]!, length: boundary[1]!.length, quotes: line.quotes, list_width: line.list_width }
        cursor = line_end + 1
        continue
      }
      cursor = line.cursor
    }
    if (source[cursor] === '\\') {
      cursor += 2
      continue
    }
    if (source[cursor] === '`') {
      let open_end = cursor + 1
      while (source[open_end] === '`')
        open_end ++
      const length = open_end - cursor
      let next = source.indexOf('`', open_end)
      let closed = false
      while (next !== - 1 && next < end) {
        let close_end = next + 1
        while (source[close_end] === '`')
          close_end ++
        if (close_end - next === length) {
          cursor = close_end
          closed = true
          break
        }
        next = source.indexOf('`', close_end)
      }
      if (! closed)
        cursor = open_end
      continue
    }
    if (source.startsWith('<!--', cursor)) {
      const close = source.indexOf('-->', cursor + 4)
      cursor = close === - 1 ? end : close + 3
      continue
    }
    if (source[cursor] !== '<') {
      cursor ++
      continue
    }
    const tag = read_html_tag(source, cursor)
    if (! tag || tag.end > end) {
      cursor ++
      continue
    }
    if (! tag.closing && ! tag.self_closing && ! html_void_tags.has(tag.name) && (html_no_markdown_tags.has(tag.name) || html_table_tags.has(tag.name))) {
      const close = new RegExp(`</${tag.name}\\s*>`, 'gi')
      close.lastIndex = tag.end
      const match = close.exec(source)
      cursor = match && close.lastIndex <= end ? close.lastIndex : end
      continue
    }
    if (tag.name === 'carousel') {
      if (tag.closing)
        depth --
      else if (! tag.self_closing)
        depth ++
      if (! depth)
        return { start: cursor, end: tag.end }
    }
    cursor = tag.end
  }
  return null
}

function block_source(state: StateBlock, start: number, end: number) {
  const offsets: number[] = []
  const lines: string[] = []
  for (let line = start; line < end; line ++) {
    const content = state.getLines(line, line + 1, state.blkIndent, false)
    const leading = /^[\t ]*/.exec(content)![0].length
    const raw = state.src.slice(state.bMarks[line]!, state.eMarks[line]!)
    const raw_content = raw.lastIndexOf(content.slice(leading))
    for (let column = 0; column < content.length; column ++)
      offsets.push(state.bMarks[line]! + Math.max(0, raw_content + column - leading))
    lines.push(content)
    if (line + 1 < end)
      offsets.push(state.eMarks[line]!)
  }
  offsets.push(state.eMarks[end - 1]!)
  return { text: lines.join('\n'), offsets }
}

/** Paired carousel tags share block/inline placement with the private wrapper. */
export function content_carousel_plugin(md: MarkdownIt, recover_private_source = false) {
  md.block.ruler.before('html_block', 'content_carousel_block', (state, start, end, silent) => {
    if (state.sCount[start]! - state.blkIndent >= 4)
      return false
    const raw_start = state.bMarks[start]! + state.tShift[start]!
    if (! /^<carousel(?=[\t\n\f\r />])/i.test(state.src.slice(raw_start, raw_start + 10)))
      return false
    const direct = state.level === 0 && state.blkIndent === 0
    let limit = end
    if (! direct) {
      for (let line = start + 1; line < end; line ++) {
        if (state.sCount[line]! < state.blkIndent && state.src.slice(state.bMarks[line]!, state.eMarks[line]!).trim()) {
          limit = line
          break
        }
      }
    }
    // Ordinary top-level blocks already have contiguous source and identity
    // offsets. Only Markdown containers need a decontainered source buffer.
    const normalized = direct ? null : block_source(state, start, limit)
    const source = normalized?.text ?? state.src
    const source_end = normalized ? source.length : state.eMarks[limit - 1]!
    const offset = (position: number) => normalized ? normalized.offsets[position]! : position
    const opening_start = normalized ? normalized.offsets.indexOf(raw_start) : raw_start
    let open = read_content_carousel_open(source, opening_start)
    if (! open && recover_private_source && ! /^<carousel\s*\/>/i.test(source.slice(opening_start))) {
      const boundary = source.indexOf('>', opening_start)
      const newline = source.indexOf('\n', opening_start)
      open = { end: boundary === - 1 ? (newline === - 1 ? source_end : newline) : boundary + 1, attrs: [] }
    }
    if (! open || open.end > source_end)
      return false
    const close = find_content_carousel_close(source, open.end, source_end)
    if (! close && ! recover_private_source)
      return false
    const close_end = close?.end ?? source_end
    const raw_end = offset(close_end)
    if (raw_end <= state.eMarks[start]! && state.src.slice(raw_end, state.eMarks[start]!).trim())
      return false
    if (silent)
      return true
    let last_line = start
    while (last_line + 1 < limit && state.eMarks[last_line]! < raw_end)
      last_line ++
    const token = state.push('content_carousel_block', '', 0)
    token.block = true
    token.map = [start, last_line + 1]
    token.content = source.slice(open.end, close?.start ?? source_end)
    token.markup = state.src.slice(raw_start, raw_end)
    token.attrs = open.attrs
    token.meta = { body_start: offset(open.end), body_end: offset(close?.start ?? source_end), open_length: offset(open.end) - raw_start, closed: Boolean(close) } satisfies ContentCarouselMeta
    const trailing = state.src.slice(raw_end, state.eMarks[last_line]!)
    if (trailing.trim()) {
      const paragraph = state.push('paragraph_open', 'p', 1)
      paragraph.map = [last_line, last_line + 1]
      const inline = state.push('inline', '', 0)
      inline.map = paragraph.map
      inline.content = trailing
      inline.children = []
      state.push('paragraph_close', 'p', - 1)
    }
    state.line = last_line + 1
    return true
  }, { alt: ['paragraph', 'reference', 'blockquote', 'list'] })
  md.inline.ruler.before('html_inline', 'content_carousel_inline', (state, silent) => {
    const start = state.pos
    const raw: string[] = []
    for (const token of state.tokens) {
      if (token.type !== 'html_inline')
        continue
      const tag = read_html_tag(token.content, 0)
      if (! tag || (! html_no_markdown_tags.has(tag.name) && ! html_table_tags.has(tag.name)))
        continue
      if (tag.closing) {
        const opening = raw.lastIndexOf(tag.name)
        if (opening !== - 1)
          raw.splice(opening)
      }
      else if (! tag.self_closing && ! html_void_tags.has(tag.name)) {
        raw.push(tag.name)
      }
    }
    if (raw.length)
      return false
    const open = read_content_carousel_open(state.src, start)
    if (! open || open.end > state.posMax)
      return false
    const close = find_content_carousel_close(state.src, open.end, state.posMax)
    if (! close && ! recover_private_source)
      return false
    if (! silent) {
      const token = state.push('content_carousel_inline', '', 0)
      token.content = state.src.slice(open.end, close?.start ?? state.posMax)
      token.markup = state.src.slice(start, close?.end ?? state.posMax)
      token.attrs = open.attrs
      token.meta = { body_start: open.end, body_end: close?.start ?? state.posMax, open_length: open.end - start, closed: Boolean(close) } satisfies ContentCarouselMeta
    }
    state.pos = close?.end ?? state.posMax
    return true
  })
}
