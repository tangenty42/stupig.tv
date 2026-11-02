// CodeMirror language wiring for the story markdown editor: markdown with
// HTML tag support, where markdown inside HTML elements is parsed as
// markdown (emphasis, links, lists, ...), matching the preview renderer —
// every element except the raw-text/code/embedded and HTML table blocklists.
import { html as html_lang } from '@codemirror/lang-html'
import { markdown as markdown_lang, markdownLanguage } from '@codemirror/lang-markdown'
import { EditorState } from '@codemirror/state'
import { tags } from '@lezer/highlight'
import { html_table_tags } from '@shared/content-html'
import { create_content_markdown_parser } from '@shared/content-markdown-syntax'
import { html_markdown_wrapper_tags } from '../html'

// lezer-markdown's built-in HTMLBlock looks for the blank line that ends a
// type-6 block in the RAW line text, so inside a blockquote a `>`-only line
// never ends the block and the html language swallows the rest of the quote,
// killing markdown highlight after e.g. `<hr />`. This replacement is the same
// parser except the blank-line test runs on the content after container
// markers. Styles mirror @lezer/markdown's HTMLBlockStyle table.
const html_empty_line = /^[ \t]*$/
const html_comment_end = /-->/
const html_processing_end = /\?>/
const html_block_style: [RegExp, RegExp][] = [
  [/^<(?:script|pre|style)(?:\s|>|$)/i, /<\/(?:script|pre|style)>/i],
  [/^\s*<!--/, html_comment_end],
  [/^\s*<\?/, html_processing_end],
  [/^\s*<![A-Z]/, />/],
  [/^\s*<!\[CDATA\[/, /\]\]>/],
  [/^\s*<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h1|h2|h3|h4|h5|h6|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|section|source|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?:\s|\/?>|$)/i, html_empty_line],
  [/^\s*(?:<\/[a-z][\w-]*\s*>|<[a-z][\w-]*(\s+[a-z:_][-\w.]*(?:\s*=\s*(?:[^\s"'=<>`]+|'[^']*'|"[^"]*"))?)*\s*>)\s*$/i, html_empty_line],
]

type MarkdownExtensionConfig = Exclude<NonNullable<NonNullable<Parameters<typeof markdown_lang>[0]>['extensions']>, readonly unknown[]>

const front_matter: MarkdownExtensionConfig = {
  defineNodes: [{ name: 'FrontMatter', block: true }, { name: 'FrontMatterMark', style: tags.processingInstruction }],
  parseBlock: [{
    name: 'FrontMatter',
    before: 'HorizontalRule',
    parse(cx, line) {
      if (cx.lineStart !== 0 || line.text.trim() !== '---')
        return false
      const children = [cx.elt('FrontMatterMark', 0, line.text.length)]
      while (cx.nextLine()) {
        if (line.text.trim() === '---') {
          children.push(cx.elt('FrontMatterMark', cx.lineStart, cx.lineStart + line.text.length))
          cx.nextLine()
          break
        }
        children.push(... cx.parser.parseInline(line.text, cx.lineStart))
      }
      cx.addElement(cx.elt('FrontMatter', 0, cx.prevLineEnd(), children))
      return true
    },
  }],
}

// Ask the renderer's block parser for table acceptance, rows and exact cell
// bounds. In particular, GFM's one-header-row table grammar is insufficient for
// MultiMarkdown captions, multiple headers/bodies and merged cells.
const table_parser = create_content_markdown_parser()
function table_tokens(source: string) {
  const tokens: ReturnType<typeof table_parser.parse> = []
  table_parser.block.parse(source, table_parser, {}, tokens)
  return tokens.some(token => token.type === 'table_open') ? tokens : null
}
const tables: MarkdownExtensionConfig = {
  defineNodes: [{ name: 'Table', block: true }, { name: 'TableHeader', style: { 'TableHeader/...': tags.heading } },
    'TableRow', { name: 'TableCell', style: tags.content }, { name: 'TableDelimiter', style: tags.processingInstruction },
    { name: 'TableCaption', style: tags.emphasis }],
  parseBlock: [{
    name: 'ContentTable',
    before: 'SetextHeading',
    leaf() {
      return {
        nextLine(cx, line, current) {
          // Only a separator can confirm a table. Parse at most twice per
          // accepted table, rather than reparsing its growing text per row.
          if (! /^[\s|:=+\-]+$/.test(line.text.slice(line.pos)) || ! line.text.includes('|'))
            return false
          if (line.indent >= line.baseIndent + 4)
            return false
          const lines: { text: string, from: number }[] = []
          function append(text: string, from: number) {
            const trimmed = text.trimStart()
            lines.push({ text: trimmed, from: from + text.length - trimmed.length })
          }
          let from = current.start
          for (const text of current.content.split('\n')) {
            append(text, from)
            from += text.length + 1
          }
          append(line.text.slice(line.pos), cx.lineStart + line.pos)
          const head = lines.map(line => line.text).join('\n')
          if (! table_tokens(head))
            return false
          const depth = cx.depth
          const marks = [... line.markers]
          while (cx.nextLine()) {
            if ((line as typeof line & { depth: number }).depth < depth)
              break
            const text = line.text.slice(line.pos)
            if (text.trim() && ! text.includes('|') && ! /^\[.+\]\s*$/.test(text))
              break
            append(text, cx.lineStart + line.pos)
            marks.push(... line.markers)
            if (/^\[.+\]\s*$/.test(text)) {
              cx.nextLine()
              break
            }
          }
          const source = lines.map(line => line.text).join('\n')
          const tokens = table_tokens(source)!
          const starts = [0]
          for (let i = 0; i < source.length; i ++) {
            if (source[i] === '\n')
              starts.push(i + 1)
          }
          const absolute = (offset: number) => {
            let lo = 0
            let hi = starts.length
            while (lo + 1 < hi) {
              const mid = (lo + hi) >> 1
              if (starts[mid]! <= offset)
                lo = mid
              else hi = mid
            }
            return lines[lo]!.from + offset - starts[lo]!
          }
          const children: ReturnType<typeof cx.elt>[] = [... marks]
          const table = tokens.find(token => token.type === 'table_open')!
          const meta = table.meta as { sep: { map: number[] }, tr: { map: number[], meta: { bounds: number[], type: number } }[] }
          const separator = meta.sep.map[0]!
          for (const row of meta.tr) {
            const cells = []
            for (let i = 0; i < row.meta.bounds.length - 1; i ++) {
              const from = row.meta.bounds[i]! + 1
              const to = row.meta.bounds[i + 1]!
              cells.push(cx.elt('TableCell', absolute(from), absolute(to), cx.parser.parseInline(source.slice(from, to), absolute(from))))
              if (i < row.meta.bounds.length - 2)
                cells.push(cx.elt('TableDelimiter', absolute(to), absolute(to + 1)))
            }
            const from = starts[row.map[0]!]!
            const to = (starts[row.map[1]!] ?? source.length + 1) - 1
            children.push(cx.elt(row.map[0]! < separator ? 'TableHeader' : 'TableRow', absolute(from), absolute(to), cells))
          }
          children.push(cx.elt('TableDelimiter', absolute(starts[separator]!), absolute((starts[separator + 1] ?? source.length + 1) - 1)))
          const caption_index = tokens.findIndex(token => token.type === 'caption_open')
          const caption = tokens[caption_index]
          if (caption?.map) {
            const from = starts[caption.map[0]]!
            const to = (starts[caption.map[1]] ?? source.length + 1) - 1
            const text = tokens[caption_index + 1]!.content
            const start = source.indexOf(text, from)
            children.push(cx.elt('TableCaption', absolute(from), absolute(to), cx.parser.parseInline(text, absolute(start))))
          }
          children.sort((a, b) => a.from - b.from)
          const table_from = absolute(starts[table.map![0]]!)
          // A table can interrupt prose without a blank line, even with several
          // header rows. Keep that prefix a paragraph, not part of the table.
          // Leaf marks are the same internal container markers Lezer injects in
          // addLeafElement; split them too so neither node receives out-of-range marks.
          const marked = current as typeof current & { marks: typeof marks }
          if (table_from > current.start) {
            const text = current.content.slice(0, table_from - current.start).trimEnd()
            const prefix = { ... current, marks: marked.marks.filter(mark => mark.to <= current.start + text.length) }
            cx.addLeafElement(prefix, cx.elt('Paragraph', current.start, current.start + text.length, cx.parser.parseInline(text, current.start)))
          }
          const body = { ... current, marks: marked.marks.filter(mark => mark.from >= table_from) }
          cx.addLeafElement(body, cx.elt('Table', table_from, absolute((starts[table.map![1]] ?? source.length + 1) - 1), children))
          return true
        },
        finish() { return false },
      }
    },
  }],
}

const container_aware_html_block: MarkdownExtensionConfig = {
  parseBlock: [{
    name: 'ContainerAwareHTMLBlock',
    before: 'HTMLBlock',
    parse(cx, line) {
      const private_block = /^<good\s*>/i.test(line.text.slice(line.pos))
      let type = - 1
      if (line.text.charCodeAt(line.pos) === 60) // '<'
        type = html_block_style.findIndex(([start]) => start.test(line.text.slice(line.pos)))
      if (type < 0 && ! private_block)
        return false
      const from = cx.lineStart + line.pos
      const end = private_block ? html_empty_line : html_block_style[type]![1]
      let private_depth = 0
      let private_line = - 1
      const at_end = () => {
        if (! private_block)
          return end === html_empty_line ? html_empty_line.test(line.text.slice(line.pos)) : end.test(line.text)
        // Unlike ordinary HTML blocks, private blocks span blank lines. Match
        // their existing renderer boundary, including nested <good> elements.
        if (private_line !== cx.lineStart) {
          private_line = cx.lineStart
          for (const match of line.text.slice(line.pos).matchAll(/<good\b[^>]*>|<\/good\s*>/gi)) {
            if (match[0].startsWith('</'))
              private_depth --
            else if (! match[0].endsWith('/>'))
              private_depth ++
          }
        }
        return private_depth <= 0
      }
      const marks: typeof line.markers = []
      let trailing = private_block || end !== html_empty_line
      while (! at_end()) {
        if (! cx.nextLine())
          break
        // Line.depth is internal (untyped) but is the only container-exit signal.
        if ((line as typeof line & { depth: number }).depth < cx.depth) {
          trailing = false
          break
        }
        // The terminating blank line belongs to the container, not the block.
        if (! private_block && end === html_empty_line && at_end())
          break
        for (const mark of line.markers)
          marks.push(mark)
      }
      if (trailing)
        cx.nextLine()
      const node_name = end === html_comment_end ? 'CommentBlock' : end === html_processing_end ? 'ProcessingInstructionBlock' : 'HTMLBlock'
      cx.addElement(cx.elt(node_name, from, cx.prevLineEnd(), marks))
      return true
    },
  }],
}

// The nested parser must itself recognize nested HTML elements, so the
// markdown and html languages are wired to each other: the html language
// nests this same markdown language, which in turn nests the html language
// again, so `<center><center>...</center></center>` keeps recursing. The
// parser fields are filled in after both languages exist (configureNesting
// reads them lazily).
const markdown_inside_html_tags: { tag: string, parser: typeof markdownLanguage.parser }[]
  = [... html_markdown_wrapper_tags, 'good'].filter(tag => ! html_table_tags.has(tag)).map(tag => ({ tag, parser: markdownLanguage.parser }))

const editor_html_lang = html_lang({
  matchClosingTags: false,
  nestedLanguages: markdown_inside_html_tags,
})

// Markdown nested inside HTML wrappers treats their indentation as cosmetic,
// matching the renderer's dedenting, so this parser drops IndentedCode.
const editor_nested_markdown_lang = markdown_lang({
  extensions: [container_aware_html_block, tables, { remove: ['IndentedCode'] }],
  htmlTagLanguage: editor_html_lang,
})

for (const entry of markdown_inside_html_tags) {
  entry.parser = editor_nested_markdown_lang.language.parser
}

// The top-level editor markdown keeps IndentedCode (real code blocks at the
// document level), sharing the same html language so HTML it contains re-nests
// into the nested markdown parser above.
export const editor_markdown_lang = markdown_lang({
  extensions: [front_matter, container_aware_html_block, tables],
  htmlTagLanguage: editor_html_lang,
})

// closeBrackets (from basicSetup) reads this language data: backtick joins the
// default pairs, so a selection wraps in `...` and an empty cursor auto-closes.
// Registered globally so it also reaches HTML regions nested in the markdown.
export const editor_close_brackets = EditorState.languageData.of(() =>
  [{ closeBrackets: { brackets: ['(', '[', '{', '\'', '"', '`'] } }])
