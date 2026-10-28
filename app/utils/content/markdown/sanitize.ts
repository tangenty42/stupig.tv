import sanitizeHtml from 'sanitize-html'

export function sanitize_story_html(html: string) {
  return sanitizeHtml(html, {
    allowedTags: [... sanitizeHtml.defaults.allowedTags, 'center', 'img', 'button', 'details', 'summary', 'video', 'audio', 'source', 'iframe'],
    allowedAttributes: {
      '*': ['class', 'id', 'title', 'lang', 'dir', 'role', 'tabindex', 'aria-*', 'data-*', 'style', 'align'],
      'a': ['href', 'name', 'target', 'rel', 'download'],
      'img': ['src', 'srcset', 'sizes', 'alt', 'width', 'height', 'loading', 'decoding', 'referrerpolicy'],
      'button': [{ name: 'type', values: ['button'] }, 'disabled'],
      'ol': ['start', 'reversed'],
      'li': ['value'],
      'td': ['colspan', 'rowspan'],
      'th': ['colspan', 'rowspan', 'scope'],
      'col': ['span'],
      'colgroup': ['span'],
      'details': ['open'],
      'video': ['src', 'poster', 'controls', 'muted', 'loop', 'autoplay', 'preload', 'width', 'height'],
      'audio': ['src', 'controls', 'muted', 'loop', 'autoplay', 'preload'],
      'source': ['src', 'type'],
      'iframe': ['src', 'title', 'loading', 'allowfullscreen'],
    },
    allowedIframeHostnames: ['player.bilibili.com'],
    exclusiveFilter: frame => frame.tag === 'iframe' && ! /^https:\/\/player\.bilibili\.com\/player\.html(?:[?#]|$)/.test(frame.attribs.src ?? ''),
    allowedSchemes: ['http', 'https', 'mailto', 'tel', 'att', 'content'],
    allowProtocolRelative: false,
    nonBooleanAttributes: [],
    allowedStyles: {
      '*': {
        'text-align': [/^(?:left|right|center|justify)$/],
        'width': [/^\d+(?:\.\d+)?(?:px|em|rem|%)$/],
        'height': [/^\d+(?:\.\d+)?(?:px|em|rem|%)$/],
        'max-width': [/^\d+(?:\.\d+)?(?:px|em|rem|%)$/],
        '--content-lqip': [/^url\(data:image\/(?:jpeg|png);base64,[a-z\d+/=]+\)$/i],
      },
    },
  })
}
