import type { StoryMarkdownPlugin } from './types'
import { folder_images } from '@shared/content-markdown'
import { local_file_name } from './links'

/**
 * A folder reference written as an image (`![](cards)`) expands into one image
 * per image inside that folder, in the attachment list's order — the same
 * result as writing a bare `![](file.png)` for each file.
 *
 * It runs as a core rule placed before the carousel rule, so the expanded run
 * is treated exactly like hand-written consecutive images: a folder of two or
 * more images becomes a carousel, a lone image stays a framed image, and mixing
 * the reference with other images on the same line behaves the same way.
 */
export const folder_images_plugin: StoryMarkdownPlugin = (md, ctx) => {
  // Anchored to the carousel rule, so carousel_plugin must run first.
  md.core.ruler.before('image_carousels', 'folder_image_expansion', (state) => {
    /**
     * A bare image token. The alt is deliberately left empty: the image rule
     * fills it with the base file name, which is what an unlabeled
     * `![](file.png)` renders.
     */
    function image_token(file_name: string) {
      const token = new state.Token('image', 'img', 0)
      token.attrs = [['src', file_name], ['alt', '']]
      token.children = []
      token.content = ''
      return token
    }

    for (const token of state.tokens) {
      const children = token.type === 'inline' ? token.children : null
      if (! children) {
        continue
      }

      for (let index = 0; index < children.length; index ++) {
        const child = children[index]
        if (child?.type !== 'image') {
          continue
        }

        // markdown-it percent-encodes destinations (CJK file names), so decode
        // before matching against the stored file names. The trailing slash is
        // stripped first: `![](cards/)` names a folder, but the attachment-path
        // check that `local_file_name` applies rejects a trailing separator.
        const src = child.attrGet('src')
        const path = src ? local_file_name(src.replace(/\/+$/, '')) : null
        if (! path) {
          continue
        }

        const images = folder_images(ctx.options.attachments(), path)
        if (! images) {
          continue
        }

        children.splice(index, 1, ... images.map(image => image_token(image.file_name)))
        index += images.length - 1
      }
    }
  })
}
