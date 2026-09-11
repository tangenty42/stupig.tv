import type { AlertType } from '../alerts'
import type { StoryMarkdownPlugin } from './types'
import { alert_icons, alert_labels, alert_marker_line_pattern } from '../alerts'

// GitHub-style blockquote alerts: a blockquote whose first paragraph opens
// with `[!NOTE]` (etc.) renders as a colored alert card, the marker line
// becoming the card title (or a custom title trailing the marker).
export const alerts_plugin: StoryMarkdownPlugin = (md) => {
  md.core.ruler.after('block', 'severity_blockquotes', (state) => {
    for (let index = 0; index < state.tokens.length - 3; index ++) {
      const opening = state.tokens[index]
      const paragraph_open = state.tokens[index + 1]
      const marker = state.tokens[index + 2]
      const paragraph_close = state.tokens[index + 3]
      if (opening?.type !== 'blockquote_open'
        || paragraph_open?.type !== 'paragraph_open'
        || marker?.type !== 'inline'
        || paragraph_close?.type !== 'paragraph_close') {
        continue
      }

      // Only the first line of the first paragraph can be the marker; any
      // following lines stay as the alert body.
      const content = marker.content.trim()
      const first_line_end = content.indexOf('\n')
      const first_line = first_line_end === - 1 ? content : content.slice(0, first_line_end)
      const match = alert_marker_line_pattern.exec(first_line)
      if (! match) {
        continue
      }

      opening.meta = {
        ... opening.meta,
        alert_type: match[1] as AlertType,
        alert_title: match[2]?.trim() || null,
      }
      if (first_line_end === - 1) {
        state.tokens.splice(index + 1, 3)
      }
      else {
        // Strip the marker line; the inline pass parses the rest into children.
        marker.content = content.slice(first_line_end + 1)
      }
    }
  })

  const default_blockquote_rule = md.renderer.rules.blockquote_open
    ?? ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options))
  md.renderer.rules.blockquote_open = (tokens, idx, options, env, self) => {
    const alert_type = tokens[idx]?.meta?.alert_type as AlertType | undefined
    if (! alert_type) {
      return default_blockquote_rule(tokens, idx, options, env, self)
    }
    const token = tokens[idx]!
    const line_attr = token.map ? ` data-line="${token.map[0]}"` : ''
    const icon = alert_icons[alert_type]
    const alert_title = token.meta?.alert_title as string | null | undefined
    const title = alert_title ? md.utils.escapeHtml(alert_title) : alert_labels[alert_type]
    return `<blockquote class="markdown-alert markdown-alert-${alert_type.toLowerCase()}"${line_attr}><p class="markdown-alert-title"><span class="iconify i-lucide:${icon}" aria-hidden="true"></span><span>${title}</span></p>\n`
  }
}
