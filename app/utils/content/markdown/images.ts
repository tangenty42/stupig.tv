import type { ContentStoryAttachment } from '@shared/types/content'
import type { RenderEnvironment, StoryMarkdownPlugin } from './types'
import { attachment_base_name, CONTENT_IMAGE_DENIED_TEXT } from '@shared/content-markdown'
import { attachment_can_read, attachment_display_url, attachment_is_restricted, redacted_version_of } from '~/utils/content/attachment'
import { image_lqip_style } from '~/utils/content/lqip'
import { local_file_name, resolve_content_url } from './links'

// Images resolve story-relative sources, feed the lightbox through the
// shared env.images list, and render inside a frame that anchors the
// "点击查看长图" cover (revealed by data-cropped when the min-w/object-crop
// rule actually clips a tall image). Carousel images additionally wrap into
// a .carousel-item with an optional caption. Private attachments use the
// server-issued readable URL for permitted viewers; everyone else gets the
// plaintext 删减版 twin when the author uploaded one (amber brand strip, tag
// 删减版), or keeps the frame and
// caption with the <img> swapped for a gray denied placeholder when there is
// none (no name, no lightbox entry).
export const images_plugin: StoryMarkdownPlugin = (md, ctx) => {
  const default_image_rule = md.renderer.rules.image
    ?? ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options))
  md.renderer.rules.image = (tokens, idx, options, env, self) => {
    const token = tokens[idx]
    const src = token?.attrGet('src')
    const carousel_item = (body: string, brand = '') => {
      const caption = token?.content && token.content !== (src ? local_file_name(src) : null)
        ? `<span class="carousel-caption">${md.renderInline(token.content, env)}</span>`
        : ''
      const content = brand ? `<span class="encrypted-block">${brand}${body}${caption}</span>` : `${body}${caption}`
      return `<span class="carousel-item${caption ? ' carousel-item-captioned' : ''}">${content}</span>`
    }
    if (src?.startsWith('iframe://')) {
      const url = `https://${src.slice('iframe://'.length)}`
      const title = token?.content || '嵌入内容'
      const frame = `<span class="img-frame iframe-frame" aria-busy="true"><iframe src="${md.utils.escapeHtml(url)}" title="${md.utils.escapeHtml(title)}" loading="lazy" allowfullscreen></iframe><span class="image-loading-mask" role="status"><span class="iconify i-lucide:loader-circle" aria-hidden="true"></span><span class="sr-only">内容加载中</span></span><span class="image-unavailable" role="img" aria-label="嵌入内容不可用"><span class="iconify i-lucide:image-off" aria-hidden="true"></span></span></span>`
      return token?.meta?.carousel ? carousel_item(frame) : frame
    }
    let denied = false
    let invalid = ! src
    /** Plaintext twin an unauthorized viewer gets instead of the ciphertext. */
    let abridged: ContentStoryAttachment | null = null
    let image_attachment: ContentStoryAttachment | undefined
    if (src && token) {
      const file_name = local_file_name(src)
      const attachment = file_name ? ctx.options.attachments().find(item => item.file_name === file_name) : undefined
      image_attachment = attachment
      if (attachment && attachment_is_restricted(attachment)) {
        const twin = redacted_version_of(ctx.options.attachments(), attachment.file_name)
        if (! attachment_can_read(attachment)) {
          if (twin) {
            abridged = twin
          }
          else {
            denied = true
          }
        }
        else {
          token.attrSet('data-private', '')
        }
      }
      if (! denied) {
        // The abridged twin is a plaintext object: point the img straight at it.
        const resolved_src = abridged ? attachment_display_url(ctx.options.static_url, abridged) : resolve_content_url(ctx.options, src)
        if (! resolved_src) {
          invalid = true
        }
        else {
          const render_env = env as RenderEnvironment
          const preview_image_index = render_env.images.push(resolved_src) - 1
          // An empty alt or one repeating the file path is not a real label; fall
          // back to the base file name for both alt and the preview aria-label.
          const base_name = file_name ? attachment_base_name(file_name) : null
          const label = token.content && token.content !== file_name ? token.content : (base_name ?? '图片')
          // The default rule rebuilds alt from the children, so swap them.
          token.children = [{ type: 'text', content: label } as unknown as NonNullable<typeof token.children>[number]]
          token.attrSet('src', resolved_src)
          token.attrSet('data-preview-index', String(preview_image_index))
          token.attrSet('role', 'button')
          token.attrSet('tabindex', '0')
          token.attrSet('aria-label', `预览：${label}`)
          const presentation = abridged ?? attachment
          if (presentation?.image && image_lqip_style(presentation)) {
            token.attrSet('width', String(presentation.image.width))
            token.attrSet('height', String(presentation.image.height))
          }
        }
      }
    }
    // The denied placeholder keeps the picture's frame (and caption below) —
    // only the <img> itself is swapped out.
    const rendered_image = denied
      ? `<span class="encrypted-image-denied" role="img"><span class="iconify i-lucide:ban" aria-hidden="true"></span><span>${CONTENT_IMAGE_DENIED_TEXT}</span></span>`
      : invalid ? '' : default_image_rule(tokens, idx, options, env, self)
    const unavailable = denied ? '' : `<span class="image-unavailable" role="img" aria-label="${invalid ? '附件不存在或引用无效' : '图片加载失败'}"><span class="iconify i-lucide:image-off" aria-hidden="true"></span></span>`
    const presentation = abridged ?? image_attachment
    const lqip = denied || invalid ? null : image_lqip_style(presentation)
    // The validated metadata also reserves geometry in engines that ignore
    // width/height aspect hints once CSS sets both dimensions to auto.
    const dimensions = lqip && presentation?.image
      ? `;--content-image-width:${presentation.image.width}px;--content-image-ratio:${presentation.image.width / presentation.image.height}`
      : ''
    const placeholder = lqip ? ` data-lqip style="${md.utils.escapeHtml(lqip + dimensions)}"` : ''
    const loading = denied || invalid ? '' : '<span class="image-loading-mask" role="status"><span class="iconify i-lucide:loader-circle" aria-hidden="true"></span><span class="sr-only">图片加载中</span></span>'
    const state = invalid ? ' data-image-error' : denied ? '' : ' aria-busy="true"'
    const framed_image = `<span class="img-frame"${placeholder}${state}>${rendered_image}${unavailable}${loading}${denied || invalid ? '' : '<span class="long-img-cover" aria-hidden="true">点击查看长图</span>'}</span>`

    // Permitted encrypted image: the normal picture/carousel body, just with
    // an amber brand strip on top marking it 机密附件. It shares the normal
    // image loading / error lifecycle; decryption is owned by the server.
    // The abridged twin (unauthorized) renders the same strip with 删减版.
    const private_image = token?.attrGet('data-private') === ''
    const brand_text = private_image ? '机密附件·完整版' : '机密附件·删减版'
    const brand_icon = private_image ? 'i-lucide:lock-keyhole-open' : 'i-lucide:lock-keyhole'
    const brand = `<span class="encrypted-block-brand"><span class="iconify ${brand_icon}" aria-hidden="true"></span><span class="encrypted-block-brand-text">${brand_text}</span></span>`
    if ((private_image || abridged) && ! token?.meta?.carousel) {
      return `<div class="encrypted-block">${brand}${framed_image}</div>\n`
    }
    const output_image = framed_image
    if (! token?.meta?.carousel) {
      return output_image
    }
    // Carousel images carry their alt text as a visible caption below the
    // image. The wrapper must be a span, not <figure>: the carousel is a
    // <p>, and a figure would force the browser to close it early. An empty
    // alt (the insertion default) or one repeating the file name is not a
    // real caption — skip it. The caption is rendered as inline markdown (like
    // a link label), so `**bold**` etc. resolve instead of showing literally.
    return carousel_item(output_image, private_image || abridged ? brand : '')
  }
}
