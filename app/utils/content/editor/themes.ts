// Editor color themes: a light/dark pair of base themes plus syntax
// highlight palettes. basicSetup's defaultHighlightStyle is light-oriented
// (#219 urls, #a11 strings, ...) and unreadable on the dark background, so
// each mode gets its own palette instead of relying on the fallback.
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { EditorView } from '@codemirror/view'
import { tags } from '@lezer/highlight'

const light_theme = EditorView.theme({
  '&': { backgroundColor: 'transparent', color: '#1e293b', height: '100%' },
  '.cm-gutters': { backgroundColor: 'transparent', color: '#94a3b8', border: 'none' },
  '.cm-foldGutter': { display: 'none !important' },
  '.cm-activeLine': { backgroundColor: 'rgba(148, 163, 184, 0.12)' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': { backgroundColor: 'rgba(14, 165, 233, 0.18)' },
  // Also the drop cursor: CodeMirror's base theme styles `.cm-cursor,
  // .cm-dropCursor` together as 1.2px solid black, so overriding only
  // `.cm-cursor` left the drag insertion line black on a dark background —
  // invisible, i.e. no insertion feedback while dragging.
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: '#0f172a' },
  '.cm-lintRange-error': { textDecorationColor: '#ef4444' },
  '.cm-lintRange-warning': { textDecorationColor: '#f59e0b' },
  '.cm-alert-marker': { fontWeight: 'bold' },
  '.cm-alert-marker-note': { color: '#0369a1' },
  '.cm-alert-marker-tip': { color: '#047857' },
  '.cm-alert-marker-important': { color: '#4338ca' },
  '.cm-alert-marker-warning': { color: '#b45309' },
  '.cm-alert-marker-caution': { color: '#b91c1c' },
}, { dark: false })

const dark_theme = EditorView.theme({
  '&': { backgroundColor: 'transparent', color: '#e2e8f0', height: '100%' },
  '.cm-gutters': { backgroundColor: 'transparent', color: '#64748b', border: 'none' },
  '.cm-foldGutter': { display: 'none !important' },
  '.cm-activeLine': { backgroundColor: 'rgba(148, 163, 184, 0.08)' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': { backgroundColor: 'rgba(56, 189, 248, 0.22)' },
  // Same as the light theme: the drag insertion line needs the caret's colour,
  // or it stays the base theme's black and vanishes on this background.
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: '#f8fafc' },
  '.cm-lintRange-error': { textDecorationColor: '#f87171' },
  '.cm-lintRange-warning': { textDecorationColor: '#fbbf24' },
  '.cm-alert-marker': { fontWeight: 'bold' },
  '.cm-alert-marker-note': { color: '#38bdf8' },
  '.cm-alert-marker-tip': { color: '#34d399' },
  '.cm-alert-marker-important': { color: '#818cf8' },
  '.cm-alert-marker-warning': { color: '#fbbf24' },
  '.cm-alert-marker-caution': { color: '#f87171' },
}, { dark: true })

const light_highlight = HighlightStyle.define([
  { tag: tags.heading, color: '#0f172a', fontWeight: 'bold' },
  { tag: tags.link, color: '#0369a1', textDecoration: 'underline' },
  { tag: tags.url, color: '#0284c7' },
  { tag: [tags.labelName, tags.processingInstruction, tags.contentSeparator], color: '#94a3b8' },
  { tag: tags.quote, color: '#64748b' },
  { tag: [tags.monospace, tags.string], color: '#15803d' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strong, fontWeight: 'bold' },
  { tag: tags.strikethrough, textDecoration: 'line-through' },
  { tag: [tags.escape, tags.character], color: '#b45309' },
  { tag: tags.comment, color: '#94a3b8' },
  { tag: tags.tagName, color: '#b45309' },
  { tag: tags.attributeName, color: '#0f766e' },
  { tag: tags.attributeValue, color: '#15803d' },
  { tag: tags.angleBracket, color: '#94a3b8' },
])

const dark_highlight = HighlightStyle.define([
  { tag: tags.heading, color: '#f1f5f9', fontWeight: 'bold' },
  { tag: tags.link, color: '#7dd3fc', textDecoration: 'underline' },
  { tag: tags.url, color: '#38bdf8' },
  { tag: [tags.labelName, tags.processingInstruction, tags.contentSeparator], color: '#64748b' },
  { tag: tags.quote, color: '#94a3b8' },
  { tag: [tags.monospace, tags.string], color: '#86efac' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strong, fontWeight: 'bold' },
  { tag: tags.strikethrough, textDecoration: 'line-through' },
  { tag: [tags.escape, tags.character], color: '#fbbf24' },
  { tag: tags.comment, color: '#64748b' },
  { tag: tags.tagName, color: '#fbbf24' },
  { tag: tags.attributeName, color: '#5eead4' },
  { tag: tags.attributeValue, color: '#86efac' },
  { tag: tags.angleBracket, color: '#64748b' },
])

export function theme_extensions(mode: 'light' | 'dark') {
  return mode === 'dark'
    ? [dark_theme, syntaxHighlighting(dark_highlight)]
    : [light_theme, syntaxHighlighting(light_highlight)]
}
