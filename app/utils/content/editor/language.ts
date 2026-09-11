// CodeMirror language wiring for the story markdown editor: markdown with
// HTML tag support, where markdown inside HTML elements is parsed as
// markdown (emphasis, links, lists, ...), matching the preview renderer —
// every element except the raw-text/code/embedded blocklist.
import { html as html_lang } from '@codemirror/lang-html'
import { markdown as markdown_lang, markdownLanguage } from '@codemirror/lang-markdown'
import { EditorState } from '@codemirror/state'
import { html_markdown_wrapper_tags } from '~/utils/content/html'

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

const container_aware_html_block: MarkdownExtensionConfig = {
  parseBlock: [{
    name: 'ContainerAwareHTMLBlock',
    before: 'HTMLBlock',
    parse(cx, line) {
      let type = - 1
      if (line.text.charCodeAt(line.pos) === 60) // '<'
        type = html_block_style.findIndex(([start]) => start.test(line.text.slice(line.pos)))
      if (type < 0)
        return false
      const from = cx.lineStart + line.pos
      const end = html_block_style[type]![1]
      const at_end = () => end === html_empty_line
        ? html_empty_line.test(line.text.slice(line.pos))
        : end.test(line.text)
      const marks: typeof line.markers = []
      let trailing = end !== html_empty_line
      while (! at_end()) {
        if (! cx.nextLine())
          break
        // Line.depth is internal (untyped) but is the only container-exit signal.
        if ((line as typeof line & { depth: number }).depth < cx.depth) {
          trailing = false
          break
        }
        // The terminating blank line belongs to the container, not the block.
        if (end === html_empty_line && at_end())
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
  = html_markdown_wrapper_tags.map(tag => ({ tag, parser: markdownLanguage.parser }))

const editor_html_lang = html_lang({
  matchClosingTags: false,
  nestedLanguages: markdown_inside_html_tags,
})

// Markdown nested inside HTML elements must not treat indented HTML (e.g. the
// `<td>` cells of a table) as indented code blocks, which would stop the
// nested highlight recursion — so this parser drops IndentedCode.
const editor_nested_markdown_lang = markdown_lang({
  extensions: [container_aware_html_block, { remove: ['SetextHeading', 'IndentedCode'] }],
  htmlTagLanguage: editor_html_lang,
})

for (const entry of markdown_inside_html_tags) {
  entry.parser = editor_nested_markdown_lang.language.parser
}

// The top-level editor markdown keeps IndentedCode (real code blocks at the
// document level), sharing the same html language so HTML it contains re-nests
// into the nested markdown parser above.
export const editor_markdown_lang = markdown_lang({
  extensions: [container_aware_html_block, { remove: ['SetextHeading'] }],
  htmlTagLanguage: editor_html_lang,
})

// closeBrackets (from basicSetup) reads this language data: backtick joins the
// default pairs, so a selection wraps in `...` and an empty cursor auto-closes.
// Registered globally so it also reaches HTML regions nested in the markdown.
export const editor_close_brackets = EditorState.languageData.of(() =>
  [{ closeBrackets: { brackets: ['(', '[', '{', '\'', '"', '`'] } }])
