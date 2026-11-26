// 正文里所有“无权查看”和“渲染失败”的占位共用这一种格式，只靠文字和图标区分。
// 服务端替换机密内容时也用它，所以放在 shared。

export type ContentPlaceholderKind = 'denied' | 'failed'
/** inline：行内；block：独占一块；media：图片框内，保留图片的位置 */
export type ContentPlaceholderSize = 'inline' | 'block' | 'media'

const icons: Record<ContentPlaceholderKind, string> = { denied: 'lucide:ban', failed: 'lucide:triangle-alert' }

export const CONTENT_PLACEHOLDER_TEXT = {
  private_denied: '你无权查看此处的机密内容',
  attachment_denied: '你无权查看此处的机密附件',
  attachment_failed: '渲染失败：附件不存在',
  story_failed: '渲染失败：档案不存在',
  image_failed: '渲染失败：图片无效',
  embed_failed: '渲染失败：嵌入内容不可用',
} as const

export function content_placeholder_classes(kind: ContentPlaceholderKind, size: ContentPlaceholderSize, extra = '') {
  return `content-placeholder content-placeholder-${kind} content-placeholder-${size}${extra ? ` ${extra}` : ''}`
}

/** 开标签和内容，不含闭合标签；用于需要由 link_close 闭合的场合。 */
export function content_placeholder_open(kind: ContentPlaceholderKind, size: ContentPlaceholderSize, text: string, extra = '') {
  const tag = size === 'block' ? 'div' : 'span'
  return `<${tag} class="${content_placeholder_classes(kind, size, extra)}" role="img" aria-label="${text}"><span class="iconify i-${icons[kind]}" aria-hidden="true"></span><span class="content-placeholder-text">${text}</span>`
}

export function content_placeholder(kind: ContentPlaceholderKind, size: ContentPlaceholderSize, text: string, extra = '') {
  return `${content_placeholder_open(kind, size, text, extra)}</${size === 'block' ? 'div' : 'span'}>`
}
