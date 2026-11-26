import type { Range } from '@codemirror/state'
import type { DecorationSet, EditorView, ViewUpdate } from '@codemirror/view'
import { syntaxTree } from '@codemirror/language'
import { Decoration, ViewPlugin } from '@codemirror/view'
import { highlightTree, tagHighlighter, tags } from '@lezer/highlight'
import { html_no_markdown_tags } from '../html'

const tag_highlighter = tagHighlighter([
  { tag: [tags.tagName, tags.processingInstruction], class: 'candidate' },
])

const good_mark = Decoration.mark({ class: 'cm-content-tag cm-content-tag-good' })
const carousel_mark = Decoration.mark({ class: 'cm-content-tag cm-content-tag-carousel' })

function content_tag_decorations(view: EditorView) {
  const { state } = view
  const tree = syntaxTree(state)
  const ranges: Range<Decoration>[] = []
  for (const { from, to } of view.visibleRanges) {
    // Use the same traversal as syntax highlighting so HTML overlay nodes
    // are visible, but markup in Markdown code spans and fences is skipped.
    highlightTree(tree, tag_highlighter, (start) => {
      const node = tree.resolveInner(start, 1)
      const standalone = node.name === 'CarouselMark'
      if (! standalone && node.name !== 'TagName')
        return
      const name = standalone ? 'carousel' : state.sliceDoc(node.from, node.to).toLowerCase()
      if (name !== 'good' && name !== 'carousel')
        return

      const tag = standalone ? node : node.parent
      if (! tag || (! standalone && tag.name !== 'OpenTag' && tag.name !== 'CloseTag'))
        return
      if (name === 'good' && ! /^<\/?good\s*>$/i.test(state.sliceDoc(tag.from, tag.to)))
        return
      for (let parent = tag.parent; parent; parent = parent.parent) {
        if (parent.name === 'FrontMatter')
          return
        if (parent.name !== 'Element')
          continue
        const opener = parent.firstChild?.getChild('TagName')
        if (opener && html_no_markdown_tags.has(state.sliceDoc(opener.from, opener.to).toLowerCase()))
          return
      }
      const mark = name === 'good' ? good_mark : carousel_mark
      ranges.push(mark.range(tag.from, tag.to))
    }, from, to)
  }
  return Decoration.set(ranges, true)
}

export const content_tag_marker_plugin = ViewPlugin.fromClass(class {
  decorations: DecorationSet

  constructor(view: EditorView) {
    this.decorations = content_tag_decorations(view)
  }

  update(update: ViewUpdate) {
    if (update.docChanged || update.viewportChanged || syntaxTree(update.startState) !== syntaxTree(update.state))
      this.decorations = content_tag_decorations(update.view)
  }
}, { decorations: plugin => plugin.decorations })
