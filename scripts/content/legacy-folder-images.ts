import type { ImageAttachment } from '@shared/content-markdown'
import type { ContentMarkdownSource } from '@shared/content-markdown-source'
import type Token from 'markdown-it/lib/token.mjs'
import { html_no_markdown_tags, html_table_tags } from '@shared/content-html'
import { attachment_markdown_path, folder_images, is_attachment_folder, strip_front_matter } from '@shared/content-markdown'
import { content_markdown_fragment, content_markdown_source, content_markdown_token_body } from '@shared/content-markdown-source'
import { create_content_markdown_parser, dedent_html_inner, split_html_wrappers } from '@shared/content-markdown-syntax'
import { content_private_plugin } from '@shared/content-private'
import { content_name_key, content_ref_suffix, parse_content_ref } from '@shared/content-reference'

export interface LegacyFolderImage {
  path: string
  line: number
  from: number
  to: number
  source: string
  kind: 'images' | 'folder-card' | 'missing'
  replacement: string | null
}

interface LocatedImage {
  token: Token
  from: number
  to: number
  caption: ContentMarkdownSource
  inside_carousel: boolean
}

/** Capture source for accepted CommonMark images, including reference-style uses. */
function locate_images(markdown: string) {
  const md = create_content_markdown_parser().use(content_private_plugin)
  const rules = md.inline.ruler.getRules('')
  md.inline.ruler.disable('image')
  const remaining = md.inline.ruler.getRules('')
  const image = rules.find(rule => ! remaining.includes(rule))!
  md.inline.ruler.enable('image')
  const spans = new WeakMap<Token, { from: number, to: number }>()
  md.inline.ruler.at('image', (state, silent) => {
    const from = state.pos
    const accepted = image(state, silent)
    if (accepted && ! silent)
      spans.set(state.tokens.at(- 1)!, { from, to: state.pos })
    return accepted
  })
  const env = {}
  const images: LocatedImage[] = []
  function inline(source: ContentMarkdownSource, tokens: Token[], inside_carousel: boolean) {
    let cursor = 0
    for (const token of tokens) {
      if (token.type === 'content_carousel_inline' || token.type === 'content_private_inline') {
        const nested = content_markdown_token_body(source, token, cursor)
        inline(nested.source, md.parseInline(nested.source.text, env)[0]?.children ?? [], inside_carousel || token.type === 'content_carousel_inline')
        cursor = nested.end
      }
      const span = spans.get(token)
      if (! span)
        continue
      const label_start = span.from + 2
      const caption = { text: token.content, offsets: source.offsets.slice(label_start, label_start + token.content.length + 1) }
      if (token.children?.length)
        inline(caption, token.children, false)
      images.push({ token, caption, inside_carousel, from: source.offsets[span.from]!, to: source.offsets[span.to - 1]! + 1 })
      cursor = span.to
    }
  }
  function block(source: ContentMarkdownSource, inside_carousel = false) {
    const lines = [0]
    for (let at = 0; at < source.text.length; at ++) {
      if (source.text[at] === '\n')
        lines.push(at + 1)
    }
    let inline_line = - 1
    let inline_end = 0
    for (const token of md.parse(source.text, env)) {
      if (! token.map)
        continue
      const start = lines[token.map[0]]!
      if (token.type === 'content_carousel_block' || token.type === 'content_private_block') {
        block(content_markdown_token_body(source, token, start).source, inside_carousel || token.type === 'content_carousel_block')
      }
      else if (token.type === 'inline' && token.children?.length) {
        // Table cells can each produce an inline token on the same source line.
        const offset = start === inline_line ? inline_end : start
        const fragment = content_markdown_fragment(source, token.content, offset)
        inline_line = start
        inline_end = Math.max(offset, source.offsets.indexOf(fragment.offsets.at(- 1)!, offset))
        inline(fragment, token.children, inside_carousel)
      }
      else if (token.type === 'html_block') {
        const html = content_markdown_fragment(source, token.content, start)
        let cursor = 0
        for (const chunk of split_html_wrappers(html.text) ?? []) {
          const at = html.text.indexOf(chunk.source, cursor)
          cursor = at + chunk.source.length
          if (! chunk.closed || html_no_markdown_tags.has(chunk.tag) || html_table_tags.has(chunk.tag))
            continue
          block(content_markdown_fragment(html, dedent_html_inner(chunk.inner), at + chunk.source.indexOf('>') + 1), inside_carousel)
        }
      }
    }
  }
  block(content_markdown_source(markdown, markdown.length - strip_front_matter(markdown).length))
  return images
}

/** Include the suggestions for nested images in their enclosing caption. */
function explicit_caption(caption: ContentMarkdownSource, previous: readonly LegacyFolderImage[]) {
  if (! caption.text.includes('!['))
    return caption.text
  const inside = previous
    .filter(item => item.replacement && item.from >= caption.offsets[0]! && item.to <= caption.offsets.at(- 1)!)
    .sort((left, right) => left.from - right.from)
  let text = ''
  let cursor = 0
  for (const item of inside) {
    const from = caption.offsets.indexOf(item.from, cursor)
    const to = caption.offsets.indexOf(item.to - 1, from)
    if (from === - 1 || to === - 1)
      continue
    text += caption.text.slice(cursor, from) + item.replacement
    cursor = to + 1
  }
  return text + caption.text.slice(cursor)
}

/** Read-only suggestions for body references. Missing paths still need human identification. */
export function scan_legacy_folder_images(markdown: string, attachments: readonly ImageAttachment[], folders: readonly string[]): LegacyFolderImage[] {
  if (! markdown.includes('!['))
    return []
  const files = new Set(attachments.map(attachment => content_name_key(attachment.file_name)))
  const results: LegacyFolderImage[] = []
  for (const { token, caption, from, to, inside_carousel } of locate_images(markdown)) {
    const src = token.attrGet('src') ?? ''
    const ref = parse_content_ref(src.replace(/\/+$/, ''))
    if (ref?.kind !== 'attachment' || files.has(content_name_key(ref.path)))
      continue
    const path = ref.path
    const line = markdown.slice(0, from).split(/\r\n|\r|\n/).length
    const source = markdown.slice(from, to)
    const suffix = content_ref_suffix(src).replace(/[\\()&]/g, '\\$&')
    const images = folder_images(attachments, path)
    if (images?.length) {
      const title = token.attrGet('title')
      const title_attr = title ? ` "${title.replace(/[\\&"]/g, '\\$&')}"` : ''
      const label = explicit_caption(caption, results)
      // Keep the replacement on the same line so it can be pasted in lists,
      // tables and surrounding prose without changing their Markdown structure.
      const links = images.map(image => `![${label}](${attachment_markdown_path(image.file_name)}${suffix}${title_attr})`).join('')
      const replacement = images.length > 1 && ! inside_carousel ? `<carousel>${links}</carousel>` : links
      results.push({ path, line, from, to, source, kind: 'images', replacement })
    }
    else if (is_attachment_folder(attachments, path, folders)) {
      results.push({ path, line, from, to, source, kind: 'folder-card', replacement: `[](${attachment_markdown_path(path)}${suffix})` })
    }
    else {
      results.push({ path, line, from, to, source, kind: 'missing', replacement: null })
    }
  }
  return results.sort((left, right) => left.from - right.from)
}
