// Highlights `[!NOTE]`-style alert markers at the start of blockquote lines;
// colors mirror the preview's markdown-alert palette.
import type { DecorationSet, EditorView, ViewUpdate } from '@codemirror/view'
import { Decoration, MatchDecorator, ViewPlugin } from '@codemirror/view'
import { alert_types } from '~/utils/content/alerts'

const alert_marker_decorator = new MatchDecorator({
  regexp: new RegExp(`^[ \\t]*(?:>[ \\t]?)+\\[!(${alert_types.join('|')})\\]`, 'gm'),
  decorate: (add, from, to, match) => {
    const marker_from = from + match[0].indexOf('[!')
    add(marker_from, to, Decoration.mark({ class: `cm-alert-marker cm-alert-marker-${match[1]!.toLowerCase()}` }))
  },
})

export const alert_marker_plugin = ViewPlugin.fromClass(class {
  decorations: DecorationSet

  constructor(view: EditorView) {
    this.decorations = alert_marker_decorator.createDeco(view)
  }

  update(update: ViewUpdate) {
    this.decorations = alert_marker_decorator.updateDeco(update, this.decorations)
  }
}, { decorations: value => value.decorations })
