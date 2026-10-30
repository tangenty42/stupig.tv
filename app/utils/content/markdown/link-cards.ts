import type { ContentStorySummary } from '@shared/types/content'
import type MarkdownIt from 'markdown-it'
import type { FileCardData, StoryCardMeta, StoryMarkdownContext, StoryMarkdownPlugin } from './types'
import { attachment_base_name, CONTENT_ATTACHMENT_DENIED_TEXT, decrypted_attachment_name, folder_file_count, is_attachment_folder } from '@shared/content-markdown'
import { content_name_key, parse_content_ref } from '@shared/content-reference'
import { story_rating, story_rating_rank } from '@shared/types/content'
import { attachment_can_read, attachment_display_url, attachment_is_restricted, cover_alt, file_icon, redacted_version_of, story_front_cover_url } from '~/utils/content/attachment'
import { render_story_cover } from '~/utils/content/story-cover'
import { format_bytes } from '~/utils/size'
import { apply_chip_gaps } from './chips'
import { find_story_by_title, local_file_name, resolve_content_url, with_reference_suffix } from './links'

/** Shared two-line body for files, folders and unavailable private files. */
function file_card_body_open(md: MarkdownIt, card: FileCardData) {
  return `<span class="file-card-icon iconify i-${card.icon}" aria-hidden="true"></span><span class="file-card-content"><span class="file-card-name">${card.name ? md.utils.escapeHtml(card.name) : ''}`
}

function file_card_body_close(card: FileCardData) {
  const tag = card.encrypted ? `<span class="file-card-encrypted-tag">${card.abridged ? '机密附件·删减版' : '机密附件'}</span>` : ''
  const size = card.size ? `<span class="file-card-size">${card.size}${tag}</span>` : ''
  return `</span>${size}</span>`
}

/**
 * Inner HTML of a story reference card: a
 * primary 蠢猪档案 brand strip on top, then an optional full-width cover,
 * then the title and an optional description line. The rating shows as a
 * large, translucent tier SVG badge on its own line at the bottom right of
 * the card content, so it never overlaps the text (imgs/ratings/1-5.svg,
 * 1=夯 … 5=拉完了; rank r maps to file 6-r, unrated 难评 has none). Dead
 * references (target story gone) render a muted placeholder cover with the
 * raw title.
 */
function story_card_inner(md: MarkdownIt, ctx: StoryMarkdownContext, story: ContentStorySummary | null, fallback_title = '') {
  // Dead references are spans without navigation, so they get no out icon.
  const out = story ? '<span class="story-card-out iconify i-lucide:external-link" aria-hidden="true"></span>' : ''
  const brand = `<span class="story-card-brand"><span class="iconify i-lucide:book-open" aria-hidden="true"></span><span class="story-card-brand-text">蠢猪档案</span>${out}</span>`
  if (! story) {
    return `${brand}<span class="story-card-cover story-card-cover-empty"><span class="iconify i-lucide:book-x" aria-hidden="true"></span></span><span class="story-card-content"><span class="story-card-title">${md.utils.escapeHtml(fallback_title)}</span></span>`
  }
  const rank = story_rating_rank(story.labels)
  const rating = rank
    ? `<img class="built-in-img story-card-rating" src="${ctx.options.static_url(`imgs/ratings/${6 - rank}.svg`)}" alt="${md.utils.escapeHtml(story_rating(story.labels))}" loading="lazy" referrerpolicy="no-referrer">`
    : ''
  const cover_src = story.cover
    ? story_front_cover_url(ctx.options.static_url, story.cover, story.cover_url)
    : undefined
  const cover = cover_src
    ? `<span class="story-card-cover">${render_story_cover(cover_src, cover_alt(story.cover, story.cover_label, story.title), story.cover_image)}</span>`
    : ''
  const desc = story.desc ? `<span class="story-card-desc">${md.utils.escapeHtml(story.desc)}</span>` : ''
  return `${brand}${cover}<span class="story-card-content"><span class="story-card-title">${md.utils.escapeHtml(story.title)}</span>${desc}${rating}</span>`
}

/**
 * Inner HTML of a folder card, laid out like the file card — leading icon, then
 * the folder name over a muted line. The icon is what tells it apart from a
 * file, and the second line carries how much is inside. The markup is balanced
 * on its own, because the caller renders it as a span rather than a link: the
 * folder is not a destination on its own, so the host page decides what opening
 * it means (the attachment list expands the folder and scrolls to it).
 *
 * `data-folder-card` carries the path and is deliberately not the attachment
 * rows' `data-folder`, so the list's drop-target lookup never matches a card.
 */
function folder_card_inner(md: MarkdownIt, ctx: StoryMarkdownContext, folder_path: string) {
  const name = attachment_base_name(folder_path)
  // Empty workspace directories are real targets and report zero files.
  const summary = `${folder_file_count(ctx.options.attachments(), folder_path)} 个文件`
  const card = { icon: 'lucide:folder', name, size: summary }
  return file_card_body_open(md, card) + file_card_body_close(card)
}

/** The folder card's opening tag, with the path and the button semantics the preview wires up. */
function folder_card_open_tag(md: MarkdownIt, ctx: StoryMarkdownContext, folder_path: string) {
  const interactive = ctx.options.folder_card_openable()
  const escaped_name = md.utils.escapeHtml(attachment_base_name(folder_path))
  // The data attribute is what the preview's click handler looks for, so it is
  // only emitted where the host can actually open the folder.
  if (! interactive) {
    return '<span class="link-card file-card folder-card">'
  }
  const escaped_path = md.utils.escapeHtml(folder_path)
  return `<span class="link-card file-card folder-card" data-folder-card="${escaped_path}" role="button" tabindex="0" aria-label="在附件中展开：${escaped_name}">`
}

// Label-off links (`[](dest)`) render as cards — story reference cards for
// `@title` and file cards for story-relative file names.
export const link_cards_plugin: StoryMarkdownPlugin = (md, ctx) => {
  const default_link_rule = md.renderer.rules.link_open
    ?? ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options))
  md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
    const token = tokens[idx]
    let href = token?.attrGet('href')
    const has_text_label = tokens[idx + 1]?.type === 'text' && tokens[idx + 2]?.type === 'link_close'
    // The link's closing token: link_close right after the open (no label), or
    // after a single plain-text label. -1 when the label carries markup, which
    // leaves the right-hand chip gap to the helper's index fallback.
    const close_index = has_text_label ? idx + 2 : (tokens[idx + 1]?.type === 'link_close' ? idx + 1 : - 1)
    if (href) {
      // `[](@title)` (label-off) renders as a story card; a labeled
      // `[text](@title)` keeps the normal-link rendering with the story URL
      // resolved, so it looks like any other link.
      const reference = parse_content_ref(href)
      if (reference?.kind === 'story' || reference?.kind === 'legacy_story') {
        const story_title = reference.title
        const story = find_story_by_title(ctx.options, story_title)
        if (tokens[idx + 1]?.type !== 'link_close') {
          if (story) {
            href = with_reference_suffix(`/content/${story.id}`, href)
          }
        }
        else {
          apply_chip_gaps(token!, tokens, idx, close_index, 'card')
          const story_card: StoryCardMeta = { dead: ! story }
          token!.meta = { ... token?.meta, story_card }
          const closing = close_index !== - 1 ? tokens[close_index] : undefined
          if (closing?.type === 'link_close') {
            closing.meta = { ... closing.meta, story_card }
          }
          if (story) {
            token!.attrSet('href', with_reference_suffix(`/content/${story.id}`, href))
            token!.attrSet('target', '_blank')
            token!.attrSet('rel', 'noopener noreferrer')
            token!.attrJoin('class', 'link-card story-card')
            return `${default_link_rule(tokens, idx, options, env, self)}${story_card_inner(md, ctx, story)}`
          }
          // Dead reference: the target story is gone; render a muted placeholder.
          return `<span class="link-card story-card story-card-dead">${story_card_inner(md, ctx, null, story_title)}`
        }
      }

      // A label-off link (`[](file.sql)`) has no text token: link_close
      // follows link_open directly and the card renders the file name itself.
      const label = has_text_label ? tokens[idx + 1]!.content : null
      const file_name = local_file_name(href)
      // A label merely repeating the file path is not a real label; show the
      // base file name instead.
      if (label !== null && label === file_name) {
        tokens[idx + 1]!.content = decrypted_attachment_name(attachment_base_name(file_name))
      }
      const visible_label = label === file_name ? null : label
      token!.attrSet('href', resolve_content_url(ctx.options, href))
      token!.attrSet('target', '_blank')
      token!.attrSet('rel', 'noopener noreferrer')
      token!.attrJoin('class', 'link link-card')
      // Private attachments: permitted viewers get the normal version. Others
      // get a redacted version when available (amber card, tag 删减版), or a
      // gray nameless card when there is none — whatever shape the link had.
      const link_attachment = file_name ? ctx.options.attachments().find(item => content_name_key(item.file_name) === content_name_key(file_name)) : undefined
      const link_twin = (link_attachment && attachment_is_restricted(link_attachment)) ? redacted_version_of(ctx.options.attachments(), link_attachment.file_name) : null
      if ((link_attachment && attachment_is_restricted(link_attachment))) {
        if (! attachment_can_read(link_attachment) && ! link_twin) {
          apply_chip_gaps(token!, tokens, idx, close_index, 'card')
          token!.meta = { ... token?.meta, encrypted_denied: true }
          const closing_denied = close_index !== - 1 ? tokens[close_index] : undefined
          if (closing_denied?.type === 'link_close') {
            closing_denied.meta = { ... closing_denied.meta, encrypted_denied: true }
          }
          const denied = { icon: 'lucide:ban', name: CONTENT_ATTACHMENT_DENIED_TEXT, size: '' }
          return `<span class="link-card file-card encrypted-card-denied">${file_card_body_open(md, denied)}${file_card_body_close(denied)}`
        }
        if (! attachment_can_read(link_attachment) && link_twin) {
          // Abridged substitution: the link points at the plaintext twin.
          token!.attrSet('href', attachment_display_url(ctx.options.static_url, link_twin))
          token!.attrJoin('class', 'file-card-encrypted')
          if (visible_label === null && close_index !== - 1) {
            token!.attrJoin('class', 'file-card')
            apply_chip_gaps(token!, tokens, idx, close_index, 'card')
            token!.meta = {
              ... token?.meta,
              file_card: {
                icon: 'lucide:lock-keyhole',
                size: format_bytes(link_twin.file_size),
                name: label === null ? decrypted_attachment_name(attachment_base_name(link_twin.file_name)) : null,
                encrypted: true,
                abridged: true,
              } satisfies FileCardData,
            }
            const closing_abridged = tokens[close_index]
            if (closing_abridged?.type === 'link_close') {
              closing_abridged.meta = { ... closing_abridged.meta, file_card: token?.meta.file_card }
            }
          }
        }
        else {
          token!.attrSet('data-private', '')
          token!.attrJoin('class', 'file-card-encrypted')
        }
      }
      if (file_name && close_index !== - 1 && visible_label === null && ! token?.meta?.file_card) {
        const attachment = ctx.options.attachments().find(item => content_name_key(item.file_name) === content_name_key(file_name))
        if (! attachment) {
          // A label-off link to a folder. Without this it would fall into the
          // silent dead-link branch below and vanish, since a folder has no
          // attachment row of its own.
          if (is_attachment_folder(ctx.options.attachments(), file_name, ctx.options.folders?.())) {
            token!.meta = { ... token?.meta, folder_card: true }
            const closing_folder = tokens[close_index]
            if (closing_folder?.type === 'link_close') {
              closing_folder.meta = { ... closing_folder.meta, folder_card: true }
            }
            return `${folder_card_open_tag(md, ctx, file_name)}${folder_card_inner(md, ctx, file_name)}`
          }
          // Unlabeled link to a file this story doesn't have: render nothing.
          token!.meta = { ... token?.meta, silent_link: true }
          const closing = tokens[close_index]
          if (closing?.type === 'link_close') {
            closing.meta = { ... closing.meta, silent_link: true }
          }
          return ''
        }
        token!.attrJoin('class', 'link-card file-card')
        // The card is the whole link (link_open, optional text label,
        // link_close), so the right edge check looks past link_close.
        apply_chip_gaps(token!, tokens, idx, close_index, 'card')
        token!.meta = {
          ... token?.meta,
          file_card: {
            icon: attachment_is_restricted(attachment) ? 'lucide:lock-keyhole-open' : file_icon(attachment),
            size: attachment ? format_bytes(attachment.file_size) : '未知大小',
            name: label === null ? decrypted_attachment_name(attachment_base_name(file_name)) : null,
            encrypted: attachment_is_restricted(attachment) || undefined,
          } satisfies FileCardData,
        }
        const closing = tokens[close_index]
        if (closing?.type === 'link_close') {
          closing.meta = { ... closing.meta, file_card: token?.meta.file_card }
        }
      }
    }
    const file_card = token?.meta?.file_card as FileCardData | undefined
    // A plain link renders in the same dashed chip chrome as the cards, so it
    // takes the same side gaps; link-chip marks it as the wrappable inline
    // variant (the cards above stay atomic flex boxes). The class has to be
    // joined before the tag is rendered below; the paths that claimed a gap
    // higher up all returned.
    if (! file_card) {
      token!.attrJoin('class', 'link-chip')
      apply_chip_gaps(token!, tokens, idx, close_index, 'card')
    }

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
    if (tokens[idx]?.meta?.silent_link) {
      return ''
    }
    if (tokens[idx]?.meta?.folder_card) {
      // Closes the span the folder card opened; the card renders no out icon
      // because it does not navigate yet.
      return '</span>'
    }
    if (tokens[idx]?.meta?.encrypted_denied) {
      // Closes the span the denied encrypted card opened.
      return '</span>'
    }
    const story_card = tokens[idx]?.meta?.story_card as StoryCardMeta | undefined
    if (story_card) {
      // Vertical block card: no trailing out icon; the
      // dead placeholder replaced the link with a span.
      return story_card.dead ? '</span>' : default_link_close_rule(tokens, idx, options, env, self)
    }
    const file_card = tokens[idx]?.meta?.file_card as FileCardData | undefined
    if (! file_card) {
      return `</span><span class="link-card-open iconify i-lucide:external-link" aria-hidden="true"></span>${default_link_close_rule(tokens, idx, options, env, self)}`
    }
    return `${file_card_body_close(file_card)}<span class="link-card-open iconify i-lucide:external-link" aria-hidden="true"></span>${default_link_close_rule(tokens, idx, options, env, self)}`
  }
}
