import type { ContentStoryAttachment } from '@shared/types/content'
import type { RenderEnvironment, StoryMarkdownPlugin } from './types'
import { attachment_base_name, CONTENT_IMAGE_DENIED_TEXT } from '@shared/content-markdown'
import { abridged_twin_of } from '~/utils/content/attachment'
import { local_file_name, resolve_content_url } from './links'

// Images resolve story-relative sources, feed the lightbox through the
// shared env.images list, and render inside a frame that anchors the
// "点击查看长图" cover (revealed by data-cropped when the min-w/object-crop
// rule actually clips a tall image). Carousel images additionally wrap into
// a .carousel-item with an optional caption. Encrypted attachments render as
// ciphertext with data-encrypted (the preview swaps in a decrypted blob URL)
// for permitted viewers; everyone else gets the plaintext 删减版 twin when the
// author uploaded one (amber brand strip, tag 删减版), or keeps the frame and
// caption with the <img> swapped for a gray denied placeholder when there is
// none (no name, no lightbox entry).
export const images_plugin: StoryMarkdownPlugin = (md, ctx) => {
  const default_image_rule = md.renderer.rules.image
    ?? ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options))
  md.renderer.rules.image = (tokens, idx, options, env, self) => {
    const token = tokens[idx]
    const src = token?.attrGet('src')
    let denied = false
    /** Plaintext twin an unauthorized viewer gets instead of the ciphertext. */
    let abridged: ContentStoryAttachment | null = null
    /** Permitted viewer with a twin: the card carries a full/abridged toggle. */
    let twin_url: string | null = null
    if (src && token) {
      const file_name = local_file_name(src)
      const attachment = file_name ? ctx.options.attachments().find(item => item.file_name === file_name) : undefined
      if (attachment?.is_encrypted) {
        const twin = abridged_twin_of(ctx.options.attachments(), attachment.file_name)
        if (! attachment.encryption_key) {
          if (twin) {
            abridged = twin
          }
          else {
            denied = true
          }
        }
        else {
          token.attrSet('data-encrypted', '')
          if (twin) {
            twin_url = ctx.options.static_url(twin.url)
          }
        }
      }
      if (! denied) {
        // The abridged twin is a plaintext object: point the img straight at it.
        const resolved_src = abridged ? ctx.options.static_url(abridged.url) : resolve_content_url(ctx.options, src)
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
        token.attrSet('aria-label', `预览图片：${label}`)
      }
    }
    // The denied placeholder keeps the picture's frame (and caption below) —
    // only the <img> itself is swapped out.
    const rendered_image = denied
      ? `<span class="encrypted-image-denied" role="img"><span class="iconify i-lucide:ban" aria-hidden="true"></span><span>${CONTENT_IMAGE_DENIED_TEXT}</span></span>`
      : default_image_rule(tokens, idx, options, env, self)
    const framed_image = `<span class="img-frame">${rendered_image}${denied ? '' : '<span class="long-img-cover" aria-hidden="true">点击查看长图</span>'}</span>`

    // Permitted encrypted image: the normal picture/carousel body, just with
    // an amber brand strip on top marking it 机密附件. Until the preview swaps
    // in the decrypted blob, a loader stands in and the ciphertext img hides.
    // The abridged twin (unauthorized) renders the same strip with 删减版.
    const encrypted = ! denied && ! abridged && token?.attrGet('data-encrypted') !== null && token?.attrGet('data-encrypted') !== undefined
    const loading = encrypted ? '<span class="encrypted-image-loading" aria-hidden="true"><span class="iconify i-lucide:loader-circle"></span></span>' : ''
    const brand_text = encrypted ? '机密附件·解密中' : '机密附件·删减版'
    const brand_icon = encrypted ? 'i-lucide:lock-keyhole-open' : 'i-lucide:lock-keyhole'
    const brand = `<span class="encrypted-block-brand"><span class="iconify ${brand_icon}" aria-hidden="true"></span><span class="encrypted-block-brand-text">${brand_text}</span></span>`
    // Full/abridged toggle bar at the very bottom, permitted viewers only.
    const toggle_bar = twin_url ? '<span class="encrypted-toggle-bar"><span class="encrypted-toggle" role="button" tabindex="0">查看删减版</span></span>' : ''
    const toggle_attr = twin_url ? ` data-twin-url="${md.utils.escapeHtml(twin_url)}"` : ''
    if ((encrypted || abridged) && ! token?.meta?.carousel) {
      const hidden_image = encrypted ? framed_image.replace('<img', '<img hidden') : framed_image
      return `<div class="encrypted-block"${toggle_attr}>${brand}${loading}${hidden_image}${toggle_bar}</div>\n`
    }
    const output_image = encrypted ? framed_image.replace('<img', `${loading}<img hidden`) : framed_image
    if (! token?.meta?.carousel) {
      return output_image
    }
    // Carousel images carry their alt text as a visible caption below the
    // image. The wrapper must be a span, not <figure>: the carousel is a
    // <p>, and a figure would force the browser to close it early. An empty
    // alt (the insertion default) or one repeating the file name is not a
    // real caption — skip it. The caption is rendered as inline markdown (like
    // a link label), so `**bold**` etc. resolve instead of showing literally.
    const caption = token.content && token.content !== (src ? local_file_name(src) : null)
      ? `<span class="carousel-caption">${md.renderInline(token.content, env)}</span>`
      : ''
    const captioned = caption ? ' carousel-item-captioned' : ''
    // The encrypted marker is a brand strip above the normal item body;
    // carousel items must stay spans, so CSS gives the strip its block look.
    // The caption joins inside the card, the toggle bar closes it at the bottom.
    const item_content = encrypted || abridged
      ? `<span class="encrypted-block"${toggle_attr}>${brand}${output_image}${caption}${toggle_bar}</span>`
      : `${output_image}${caption}`
    return `<span class="carousel-item${captioned}">${item_content}</span>`
  }
}
