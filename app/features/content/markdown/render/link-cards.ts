import type { ContentPlaceholderKind } from '@shared/content-placeholder'
import type { ContentStorySummary } from '@shared/types/content'
import type MarkdownIt from 'markdown-it'
import type Token from 'markdown-it/lib/token.mjs'
import type { FileCardData, StoryMarkdownContext, StoryMarkdownPlugin } from './types'
import { attachment_base_name, attachment_name_without_private_suffix, attachment_path_is_private, CONTENT_ATTACHMENT_DENIED_TEXT, folder_item_count, is_attachment_folder } from '@shared/content-markdown'
import { content_placeholder_open, CONTENT_PLACEHOLDER_TEXT } from '@shared/content-placeholder'
import { content_name_key, parse_content_ref } from '@shared/content-reference'
import { story_rating, story_rating_rank } from '@shared/types/content'
import { attachment_can_read, attachment_display_url, attachment_is_restricted, file_icon, redacted_version_of } from '~/features/content/attachments/rules'
import { cover_alt, render_story_cover, story_front_cover_url } from '~/features/content/story-cover'
import { story_rating_image_url } from '~/features/content/story-presentation'
import { format_bytes } from '~/utils/size'
import { attachment_brand } from './attachment-brand'
import { find_story_by_title, local_file_name, resolve_content_url, with_reference_suffix } from './links'

/** Shared two-line body for files, folders and unavailable private files. */
function file_card_body_open(md: MarkdownIt, card: FileCardData) {
  const brand = card.privacy ? attachment_brand(card.privacy) : ''
  return `${brand}<span class="file-card-body"><span class="file-card-icon iconify i-${card.icon}" aria-hidden="true"></span><span class="file-card-content"><span class="file-card-name">${md.utils.escapeHtml(card.name)}`
}

function file_card_body_close(card: FileCardData, external = false) {
  const size = card.size ? `<span class="file-card-size">${card.size}</span>` : ''
  const icon = external ? '<span class="link-card-open iconify i-lucide:external-link" aria-hidden="true"></span>' : ''
  return `</span>${size}</span>${icon}</span>`
}

/**
 * Inner HTML of a story reference card: a
 * primary 蠢猪档案 brand strip on top, then an optional full-width cover,
 * then the title and an optional description line. The rating shows as a
 * large, translucent tier SVG badge on its own line at the bottom right of
 * the card content, so it never overlaps the text (imgs/ratings/1-5.svg,
 * 1=夯 … 5=拉完了; rank r maps to file 6-r, unrated 难评 has none).
 */
function story_card_inner(md: MarkdownIt, ctx: StoryMarkdownContext, story: ContentStorySummary) {
  const brand = '<span class="story-card-brand"><span class="iconify i-lucide:book-open" aria-hidden="true"></span><span class="story-card-brand-text">蠢猪档案</span><span class="story-card-out iconify i-lucide:external-link" aria-hidden="true"></span></span>'
  const rank = story_rating_rank(story.labels)
  const rating = rank
    ? `<img class="built-in-img story-card-rating" src="${md.utils.escapeHtml(story_rating_image_url(ctx.options.static_url, rank))}" alt="${md.utils.escapeHtml(story_rating(story.labels))}" loading="lazy" referrerpolicy="no-referrer">`
    : ''
  const cover_src = story.cover
    ? story_front_cover_url(ctx.options.static_url, story.cover, story.cover_url)
    : undefined
  const cover = cover_src
    ? `<span class="story-card-cover">${render_story_cover(cover_src, cover_alt(story.cover, story.cover_label, story.title), story.cover_image, ctx.options.lqip_max_bytes)}</span>`
    : ''
  const desc = story.desc ? `<span class="story-card-desc">${md.utils.escapeHtml(story.desc)}</span>` : ''
  return `${brand}${cover}<span class="story-card-content"><span class="story-card-title">${md.utils.escapeHtml(story.title)}</span>${desc}${rating}</span>`
}

/**
 * Inner HTML of a folder card, laid out like the file card — leading icon, then
 * the folder name over a muted line. The icon is what tells it apart from a
 * file, and the second line carries how much is inside. The markup is balanced
 * on its own, because the caller renders it as a button-like span rather than
 * an anchor: the host page decides what opening it means (the attachment list
 * expands the folder and scrolls to it).
 *
 * `data-folder-card` carries the path and is deliberately not the attachment
 * rows' `data-folder`, so the list's drop-target lookup never matches a card.
 */
function folder_card_inner(md: MarkdownIt, ctx: StoryMarkdownContext, folder_path: string, is_private: boolean) {
  const name = attachment_base_name(folder_path)
  const summary = `${folder_item_count(ctx.options.attachments(), folder_path, ctx.options.folders?.())} 项`
  const card: FileCardData = { icon: 'lucide:folder', name, size: summary, privacy: is_private ? 'folder' : undefined }
  return file_card_body_open(md, card) + file_card_body_close(card, true)
}

/** Folder cards keep actionable semantics; the preview host decides the click outcome. */
function folder_card_open_tag(md: MarkdownIt, _ctx: StoryMarkdownContext, folder_path: string, is_private: boolean) {
  const classes = is_private ? 'link-card file-card folder-card file-card-private' : 'link-card file-card folder-card'
  const escaped_name = md.utils.escapeHtml(attachment_base_name(folder_path))
  const escaped_path = md.utils.escapeHtml(folder_path)
  return `<span class="${classes}" data-folder-card="${escaped_path}" role="button" tabindex="0" aria-label="在附件中展开：${escaped_name}">`
}

/** Replaces a link, including its label, with the shared placeholder. */
function placeholder_link(tokens: Token[], idx: number, kind: ContentPlaceholderKind, text: string) {
  const level = tokens[idx]!.level
  for (let index = idx + 1; index < tokens.length; index ++) {
    const token = tokens[index]!
    if (token.type === 'link_close' && token.level === level) {
      token.meta = { ... token.meta, placeholder: true }
      break
    }
    token.type = 'text'
    token.content = ''
  }
  return content_placeholder_open(kind, 'inline', text)
}

// Label-off links (`[](dest)`) render as cards — story reference cards for
// `@title` and file cards for story-relative file names.
export const link_cards_plugin: StoryMarkdownPlugin = (md, ctx) => {
  const default_link_rule = md.renderer.rules.link_open
    ?? ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options))
  md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
    const token = tokens[idx]
    let href = token?.attrGet('href')
    const next = tokens[idx + 1]
    const closing = next?.type === 'link_close' ? next : undefined
    if (href) {
      // `[](@title)` (label-off) renders as a story card; a labeled
      // `[text](@title)` keeps the normal-link rendering with the story URL
      // resolved, so it looks like any other link.
      const reference = parse_content_ref(href)
      if (reference?.kind === 'story') {
        const story_title = reference.title
        const story = find_story_by_title(ctx.options, story_title)
        if (! closing) {
          if (story) {
            href = with_reference_suffix(`/content/${story.id}`, href)
          }
        }
        else {
          if (! story)
            return placeholder_link(tokens, idx, 'failed', CONTENT_PLACEHOLDER_TEXT.story_failed)
          closing.meta = { ... closing.meta, story_card: true }
          token!.attrSet('href', with_reference_suffix(`/content/${story.id}`, href))
          token!.attrSet('target', '_blank')
          token!.attrSet('rel', 'noopener noreferrer')
          token!.attrJoin('class', 'link-card story-card')
          return `${default_link_rule(tokens, idx, options, env, self)}${story_card_inner(md, ctx, story)}`
        }
      }

      const file_name = local_file_name(href)
      token!.attrSet('href', resolve_content_url(ctx.options, href))
      token!.attrSet('target', '_blank')
      token!.attrSet('rel', 'noopener noreferrer')
      token!.attrJoin('class', 'link-card')
      const link_attachment = file_name ? ctx.options.attachments().find(item => content_name_key(item.file_name) === content_name_key(file_name)) : undefined
      const restricted = link_attachment && attachment_is_restricted(link_attachment)
      const link_twin = restricted ? redacted_version_of(ctx.options.attachments(), link_attachment.file_name) : null
      let abridged = false
      if (link_attachment) {
        if (attachment_can_read(link_attachment)) {
          token!.attrSet('data-attachment-url', attachment_display_url(ctx.options.static_url, link_attachment))
          if (restricted)
            token!.attrSet('data-private', '')
        }
        else if (restricted) {
          if (! link_twin)
            return placeholder_link(tokens, idx, 'denied', CONTENT_ATTACHMENT_DENIED_TEXT)
          token!.attrSet('href', attachment_display_url(ctx.options.static_url, link_twin))
          abridged = true
        }
      }
      else if (file_name && attachment_path_is_private(file_name) && ! ctx.options.can_read_private?.()
        && is_attachment_folder(ctx.options.attachments(), file_name, ctx.options.folders?.())) {
        return placeholder_link(tokens, idx, 'denied', CONTENT_ATTACHMENT_DENIED_TEXT)
      }
      if (file_name && closing) {
        const attachment = abridged ? link_twin : link_attachment
        if (! attachment) {
          // A label-off link to a folder. Without this it would fall into the
          // silent dead-link branch below and vanish, since a folder has no
          // attachment row of its own.
          if (is_attachment_folder(ctx.options.attachments(), file_name, ctx.options.folders?.())) {
            token!.meta = { ... token?.meta, folder_card: true }
            closing.meta = { ... closing.meta, folder_card: true }
            const is_private = attachment_path_is_private(file_name)
            return `${folder_card_open_tag(md, ctx, file_name, is_private)}${folder_card_inner(md, ctx, file_name, is_private)}`
          }
          // Unlabeled link to a file this story doesn't have.
          return placeholder_link(tokens, idx, 'failed', CONTENT_PLACEHOLDER_TEXT.attachment_failed)
        }
        token!.attrJoin('class', 'file-card')
        const redacted = abridged || attachment.is_redaction
        const privacy = redacted ? 'redacted' : restricted ? 'private' : undefined
        if (privacy)
          token!.attrJoin('class', redacted ? 'file-card-private file-card-redacted' : 'file-card-private')
        token!.meta = {
          ... token?.meta,
          file_card: {
            icon: file_icon(attachment),
            size: format_bytes(attachment.file_size),
            name: attachment_name_without_private_suffix(attachment_base_name(attachment.file_name)),
            privacy,
          } satisfies FileCardData,
        }
        closing.meta = { ... closing.meta, file_card: token?.meta.file_card }
      }
    }
    const file_card = token?.meta?.file_card as FileCardData | undefined
    // Plain-link labels can wrap inside their boxes.
    if (! file_card)
      token!.attrJoin('class', 'link-chip')

    const rendered_link = default_link_rule(tokens, idx, options, env, self)
    if (! file_card) {
      // Plain link: a chain icon marks it as a link on the left; wrap the
      // label so it can truncate; link_close closes the span and appends the
      // out icon at the END of the label.
      return `${rendered_link}<span class="link-card-icon iconify i-lucide:link" aria-hidden="true"></span><span class="link-card-tag">链接</span><span class="link-card-label">`
    }
    return rendered_link + file_card_body_open(md, file_card)
  }

  const default_link_close_rule = md.renderer.rules.link_close
    ?? ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options))
  md.renderer.rules.link_close = (tokens, idx, options, env, self) => {
    if (tokens[idx]?.meta?.placeholder) {
      return '</span>'
    }
    if (tokens[idx]?.meta?.folder_card) {
      // Closes the span the folder card opened; the card renders no out icon
      // because it does not navigate yet.
      return '</span>'
    }
    if (tokens[idx]?.meta?.story_card) {
      // Vertical block card: no trailing out icon.
      return default_link_close_rule(tokens, idx, options, env, self)
    }
    const file_card = tokens[idx]?.meta?.file_card as FileCardData | undefined
    if (! file_card) {
      return `</span><span class="link-card-open iconify i-lucide:external-link" aria-hidden="true"></span>${default_link_close_rule(tokens, idx, options, env, self)}`
    }
    return `${file_card_body_close(file_card, true)}${default_link_close_rule(tokens, idx, options, env, self)}`
  }
}
