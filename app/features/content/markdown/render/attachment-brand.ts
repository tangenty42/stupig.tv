import { PRIVATE_ICON, REDACTION_ICON } from '~/features/content/privacy-marker'

const privacy_labels = {
  private: '机密附件',
  redacted: '机密附件删减版',
  folder: '机密文件夹',
} as const

export type AttachmentBrand = keyof typeof privacy_labels

function privacy_brand(label: string, redacted = false, image = false) {
  const image_class = image ? ` private-image-block-brand${redacted ? ' private-image-block-brand-redacted' : ''}` : ''
  const text_class = image ? ' class="private-image-block-brand-text"' : ''
  return `<span class="attachment-privacy-brand${redacted ? ' attachment-privacy-brand-redacted' : ''}${image_class}"><span class="iconify i-${redacted ? REDACTION_ICON : PRIVATE_ICON}" aria-hidden="true"></span><span${text_class}>${label}</span></span>`
}

export function attachment_brand(privacy: AttachmentBrand, image = false) {
  return privacy_brand(privacy_labels[privacy], privacy === 'redacted', image)
}

export const private_content_brand = privacy_brand('机密内容')
