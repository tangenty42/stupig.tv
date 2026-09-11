import type { RenderEnvironment, StoryMarkdownPlugin } from './types'
import { attachment_base_name } from '@shared/content-markdown'
import { local_file_name, resolve_content_url } from './links'

// Images resolve story-relative sources, feed the lightbox through the
// shared env.images list, and render inside a frame that anchors the
// "点击查看长图" cover (revealed by data-cropped when the min-w/object-crop
// rule actually clips a tall image). Carousel images additionally wrap into
// a .carousel-item with an optional caption.
export const images_plugin: StoryMarkdownPlugin = (md, ctx) => {
  const default_image_rule = md.renderer.rules.image
    ?? ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options))
  md.renderer.rules.image = (tokens, idx, options, env, self) => {
    const token = tokens[idx]
    const src = token?.attrGet('src')
    if (src && token) {
      const resolved_src = resolve_content_url(ctx.options, src)
      const render_env = env as RenderEnvironment
      const preview_image_index = render_env.images.push(resolved_src) - 1
      // An empty alt or one repeating the file path is not a real label; fall
      // back to the base file name for both alt and the preview aria-label.
      const file_name = local_file_name(src)
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
    const rendered_image = default_image_rule(tokens, idx, options, env, self)
    const framed_image = `<span class="img-frame">${rendered_image}<span class="long-img-cover" aria-hidden="true">点击查看长图</span></span>`
    if (! token?.meta?.carousel) {
      return framed_image
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
    return `<span class="carousel-item${captioned}">${framed_image}${caption}</span>`
  }
}
