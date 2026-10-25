/** Raw text, code and embedded markup are excluded from the content Markdown dialect. */
export const html_no_markdown_tags = new Set([
  'pre', 'code', 'script', 'style', 'textarea', 'title',
  'kbd', 'samp', 'var', 'tt', 'xmp', 'plaintext',
  'iframe', 'object', 'embed', 'noscript', 'template',
  'select', 'option', 'optgroup', 'datalist', 'output',
  'canvas', 'svg', 'math', 'video', 'audio', 'picture', 'source', 'track',
])

/** HTML void elements do not open a content region, with or without a trailing slash. */
export const html_void_tags = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'])

/** The preview preserves HTML table markup instead of rendering its contents as Markdown. */
export const html_table_tags = new Set([
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'caption', 'colgroup', 'col',
])
