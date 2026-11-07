// Blockquote alert markers (`> [!NOTE]`) shared by the markdown preview
// renderer (alert card HTML) and the CodeMirror editor (completion +
// highlight colors mirror the preview's markdown-alert palette).
export const alert_types = ['NOTE', 'TIP', 'IMPORTANT', 'WARNING', 'CAUTION'] as const

export type AlertType = (typeof alert_types)[number]

export const alert_icons: Record<AlertType, string> = {
  NOTE: 'info',
  TIP: 'lightbulb',
  IMPORTANT: 'badge-alert',
  WARNING: 'triangle-alert',
  CAUTION: 'octagon-alert',
}

export const alert_labels: Record<AlertType, string> = {
  NOTE: '提示',
  TIP: 'TIP',
  IMPORTANT: '重要提示',
  WARNING: '警告',
  CAUTION: '注意',
}

// Marker line: `[!NOTE]`, optionally followed by a custom title on the same
// line (trimmed by the caller, so no leading-space handling here).
export const alert_marker_line_pattern = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\](.*)$/
