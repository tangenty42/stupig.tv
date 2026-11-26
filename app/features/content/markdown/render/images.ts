import type { ContentStoryAttachment } from '@shared/types/content'
import type { RenderEnvironment, StoryMarkdownPlugin } from './types'
import { attachment_base_name, CONTENT_IMAGE_DENIED_TEXT } from '@shared/content-markdown'
import { content_placeholder, CONTENT_PLACEHOLDER_TEXT } from '@shared/content-placeholder'
import { content_name_key } from '@shared/content-reference'
import { attachment_can_read, attachment_display_url, attachment_is_restricted, redacted_version_of } from '~/features/content/attachments/rules'
import { image_frame_size, image_loading_mask, render_image_frame } from '~/features/content/image-frame'
import { attachment_brand } from './attachment-brand'
import { local_file_name, resolve_content_url } from './links'

// Images resolve story-relative sources, feed the lightbox through the
// shared env.images list, and render inside a frame that anchors the
// "点击查看完整图片" cover (revealed by data-cropped when the min-w/object-crop
// rule actually clips a tall image). Every image uses the same .carousel-item
// and optional caption, including mixed paragraphs and inline renders. Private
// attachments use the server-issued readable URL for permitted viewers. Other
// viewers get the public 删减版 with its blue strip when available, or a gray
// placeholder in the same frame with its caption and no lightbox entry.
export const images_plugin: StoryMarkdownPlugin = (md, ctx) => {
  const default_image_rule = md.renderer.rules.image
    ?? ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options))
  md.renderer.rules.image = (tokens, idx, options, env, self) => {
    const token = tokens[idx]
    const src = token?.attrGet('src')
    const carousel_item = (body: string, brand = '') => {
      const caption = token?.content
        ? `<span class="carousel-caption">${md.renderInline(token.content, env)}</span>`
        : ''
      const content = brand ? `<span class="private-image-block">${brand}${body}${caption}</span>` : `${body}${caption}`
      return `<span class="carousel-item${caption ? ' carousel-item-captioned' : ''}">${content}</span>`
    }
    if (src?.startsWith('iframe://')) {
      const url = `https://${src.slice('iframe://'.length)}`
      const title = token?.content || '嵌入内容'
      const frame = `<span class="img-frame iframe-frame" aria-busy="true"><iframe src="${md.utils.escapeHtml(url)}" title="${md.utils.escapeHtml(title)}" loading="lazy" allowfullscreen></iframe>${image_loading_mask('内容加载中')}${content_placeholder('failed', 'media', CONTENT_PLACEHOLDER_TEXT.embed_failed, 'image-unavailable')}</span>`
      return carousel_item(frame)
    }
    let denied = false
    let invalid = ! src
    /** Public version shown to a viewer without access to the full image. */
    let abridged: ContentStoryAttachment | null = null
    let image_attachment: ContentStoryAttachment | undefined
    if (src && token) {
      const file_name = local_file_name(src)
      const attachment = file_name ? ctx.options.attachments().find(item => content_name_key(item.file_name) === content_name_key(file_name)) : undefined
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
        const resolved_src = abridged ? attachment_display_url(ctx.options.static_url, abridged) : resolve_content_url(ctx.options, src)
        if (! resolved_src) {
          invalid = true
        }
        else {
          const render_env = env as RenderEnvironment
          const preview_image_index = render_env.images.push(resolved_src) - 1
          const label = token.content || (file_name ? attachment_base_name(file_name) : '图片')
          // The default rule rebuilds alt from the children, so swap them.
          token.children = [{ type: 'text', content: label } as unknown as NonNullable<typeof token.children>[number]]
          token.attrSet('src', resolved_src)
          token.attrSet('loading', 'lazy')
          token.attrSet('data-preview-index', String(preview_image_index))
          token.attrSet('role', 'button')
          token.attrSet('tabindex', '0')
          token.attrSet('aria-label', `预览：${label}`)
          const size = image_frame_size((abridged ?? attachment)?.image)
          if (size) {
            token.attrSet('width', String(size.width))
            token.attrSet('height', String(size.height))
          }
        }
      }
    }
    const framed_image = denied
      ? `<span class="img-frame">${content_placeholder('denied', 'media', CONTENT_IMAGE_DENIED_TEXT)}</span>`
      : invalid
        ? `<span class="img-frame" data-image-error>${content_placeholder('failed', 'media', CONTENT_PLACEHOLDER_TEXT.image_failed, 'image-unavailable')}</span>`
        : render_image_frame(
            default_image_rule(tokens, idx, options, env, self),
            abridged ?? image_attachment,
            ctx.options.lqip_max_bytes,
            'inline',
            '<span class="long-img-cover" aria-hidden="true">点击查看完整图片</span>',
          )

    // The full private image gets an amber strip and its public 删减版 a blue one.
    // Both share the regular image loading and error states.
    const private_image = token?.attrGet('data-private') === ''
    const brand = private_image ? attachment_brand('private', true) : abridged || image_attachment?.is_redaction ? attachment_brand('redacted', true) : ''
    return carousel_item(framed_image, brand)
  }
}
