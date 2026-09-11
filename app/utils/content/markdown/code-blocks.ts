import type { StoryMarkdownPlugin } from './types'

// Code blocks get an inner scroll wrapper so the <pre> itself can stay
// overflow-hidden: the scrollbar then sits clear of the rounded border, the
// same outer-frame/inner-scroller layering as the CodeMirror editor.
export const code_blocks_plugin: StoryMarkdownPlugin = (md) => {
  md.renderer.rules.fence = (tokens, idx) => {
    const token = tokens[idx]!
    const info = token.info ? md.utils.unescapeAll(token.info).trim() : ''
    const lang_name = info ? md.utils.escapeHtml(info.split(/\s+/g)[0] ?? '') : ''
    const lang_class = lang_name ? ` class="language-${lang_name}"` : ''
    const line_attr = token.map ? ` data-line="${token.map[0]}"` : ''
    return `<pre${line_attr}><div class="code-scroll"><code${lang_class}>${md.utils.escapeHtml(token.content)}</code></div></pre>\n`
  }

  md.renderer.rules.code_block = (tokens, idx) => {
    const token = tokens[idx]!
    const line_attr = token.map ? ` data-line="${token.map[0]}"` : ''
    return `<pre${line_attr}><div class="code-scroll"><code>${md.utils.escapeHtml(token.content)}</code></div></pre>\n`
  }
}
