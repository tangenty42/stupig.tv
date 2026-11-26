import type { markdown } from '@codemirror/lang-markdown'
import { tags } from '@lezer/highlight'
import { read_content_carousel_open } from './content-carousel'

type MarkdownConfig = Exclude<NonNullable<NonNullable<Parameters<typeof markdown>[0]>['extensions']>, readonly unknown[]>

function is_carousel_mark(text: string) {
  const tag = text.trimEnd()
  return /^<\/carousel[\t ]*>$/i.test(tag) || read_content_carousel_open(tag)?.end === tag.length
}

// A standalone carousel tag must not turn the following Markdown into an
// ordinary HTML block. The regular inline parser handles tags alongside text.
export const content_carousel_marks: MarkdownConfig = {
  defineNodes: [{ name: 'CarouselMark', block: true, style: tags.processingInstruction }],
  parseBlock: [{
    name: 'CarouselMark',
    before: 'HTMLBlock',
    endLeaf(_cx, line) {
      return line.indent < line.baseIndent + 4 && is_carousel_mark(line.text.slice(line.pos))
    },
    parse(cx, line) {
      if (line.indent >= line.baseIndent + 4 || ! is_carousel_mark(line.text.slice(line.pos)))
        return false
      const from = cx.lineStart + line.pos
      const to = cx.lineStart + line.text.trimEnd().length
      cx.nextLine()
      cx.addElement(cx.elt('CarouselMark', from, to))
      return true
    },
  }],
}
