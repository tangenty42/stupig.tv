// Elements whose content is raw text, code, or structured/embedded markup and
// must never be parsed as markdown. Everything else may contain markdown.
export const html_no_markdown_tags = new Set([
  'pre', 'code', 'script', 'style', 'textarea', 'title',
  'kbd', 'samp', 'var', 'tt', 'xmp', 'plaintext',
  'iframe', 'object', 'embed', 'noscript', 'template',
  'select', 'option', 'optgroup', 'datalist', 'output',
  'canvas', 'svg', 'math', 'video', 'audio', 'picture', 'source', 'track',
])

// All standard HTML element names except the no-markdown blocklist, so
// markdown inside any wrapper element is parsed both in the editor (nested
// language) and the preview renderer.
export const html_markdown_wrapper_tags = [
  'a', 'abbr', 'address', 'area', 'article', 'aside', 'audio', 'b', 'base',
  'bdi', 'bdo', 'blockquote', 'body', 'br', 'button', 'canvas', 'caption',
  'center', 'cite', 'code', 'col', 'colgroup', 'data', 'datalist', 'dd', 'del',
  'details', 'dfn', 'dialog', 'div', 'dl', 'dt', 'em', 'embed', 'fieldset',
  'figcaption', 'figure', 'font', 'footer', 'form', 'h1', 'h2', 'h3', 'h4',
  'h5', 'h6', 'head', 'header', 'hgroup', 'hr', 'html', 'i', 'iframe', 'img',
  'input', 'ins', 'kbd', 'label', 'legend', 'li', 'link', 'main', 'map',
  'mark', 'marquee', 'menu', 'meta', 'meter', 'nav', 'noscript', 'object',
  'ol', 'optgroup', 'option', 'output', 'p', 'picture', 'pre', 'progress', 'q',
  'rp', 'rt', 'ruby', 's', 'samp', 'script', 'search', 'section', 'select',
  'slot', 'small', 'source', 'span', 'strike', 'strong', 'style', 'sub',
  'summary', 'sup', 'table', 'tbody', 'td', 'template', 'textarea', 'tfoot',
  'th', 'thead', 'time', 'title', 'tr', 'track', 'u', 'ul', 'var', 'video',
  'wbr',
].filter(tag => ! html_no_markdown_tags.has(tag))
