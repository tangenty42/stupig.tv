import type { BilibiliVideoCard } from '@shared/types/bilibili'
import type { ContentStorySummary } from '@shared/types/content'
import type MarkdownIt from 'markdown-it'
import type { FileCardData, RenderEnvironment, StoryCardMeta, StoryMarkdownContext, StoryMarkdownPlugin } from './types'
import { parse_bilibili_href } from '@shared/bilibili'
import { attachment_base_name, CONTENT_ATTACHMENT_DENIED_TEXT, decrypted_attachment_name, folder_file_count, is_attachment_folder } from '@shared/content-markdown'
import { story_rating, story_rating_rank } from '@shared/types/content'
import { format_bilibili_count, format_bilibili_duration } from '~/utils/bilibili'
import { bilibili_logo_svg } from '~/utils/bilibili-logo'
import { abridged_twin_of, cover_alt, file_icon, story_front_cover_url } from '~/utils/content/attachment'
import { format_bytes } from '~/utils/size'
import { apply_chip_gaps } from './chips'
import { decode_story_title, find_story_by_title, local_file_name, resolve_content_url } from './links'

/**
 * Inner HTML of a video card link, laid out like Bilibili's own card: a
 * pink 哔哩哔哩 brand strip on top, then the full-width cover (stats and
 * duration overlaid), title and uploader below. Covers live on hdslb.com,
 * which 403s requests carrying a foreign Referer, hence
 * referrerpolicy="no-referrer".
 */
function video_card_inner(md: MarkdownIt, href: string, card: BilibiliVideoCard | null | undefined) {
  const brand = `<span class="video-card-brand">${bilibili_logo_svg}<span class="video-card-brand-text">哔哩哔哩</span><span class="video-card-out iconify i-lucide:external-link" aria-hidden="true"></span></span>`
  if (! card) {
    const title = card === undefined ? '正在加载视频信息……' : href
    return `${brand}<span class="video-card-cover video-card-cover-empty"><span class="iconify i-lucide:tv" aria-hidden="true"></span></span><span class="video-card-content"><span class="video-card-title video-card-pending">${md.utils.escapeHtml(title)}</span></span>`
  }
  return `${brand}<span class="video-card-cover"><img class="built-in-img" src="${md.utils.escapeHtml(card.cover)}" alt="" loading="lazy" referrerpolicy="no-referrer"><span class="video-card-stats"><span class="video-card-stat"><span class="iconify i-lucide:play" aria-hidden="true"></span><span class="video-card-stat-value">${format_bilibili_count(card.views)}</span></span><span class="video-card-stat"><span class="iconify i-lucide:thumbs-up" aria-hidden="true"></span><span class="video-card-stat-value">${format_bilibili_count(card.likes)}</span></span></span><span class="video-card-duration">${format_bilibili_duration(card.duration)}</span></span><span class="video-card-content"><span class="video-card-title">${md.utils.escapeHtml(card.title)}</span><span class="video-card-uploader"><span class="video-card-up">UP</span>${md.utils.escapeHtml(card.uploader)}</span></span>`
}

/**
 * Inner HTML of a story reference card, laid out like the video card: a
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
    ? `<span class="story-card-cover"><img class="built-in-img" src="${md.utils.escapeHtml(cover_src)}" alt="${md.utils.escapeHtml(cover_alt(story.cover, story.cover_label, story.title))}" loading="lazy" referrerpolicy="no-referrer"></span>`
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
  // Always at least one: a folder only counts as one because a file lives under
  // it, so there is no empty case to render.
  const summary = `${folder_file_count(ctx.options.attachments(), folder_path)} 个文件`
  const escaped_name = md.utils.escapeHtml(name)
  return `<span class="file-card-icon iconify i-lucide:folder" aria-hidden="true"></span><span class="file-card-content"><span class="file-card-name">${escaped_name}</span><span class="file-card-size">${summary}</span></span>`
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
// `@title`, file cards for story-relative file names, video cards for
// Bilibili links; a labeled `[text](dest)` keeps the normal-link rendering.
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
      if (href.startsWith('@')) {
        const story_title = decode_story_title(href.slice(1))
        const story = find_story_by_title(ctx.options, story_title)
        if (has_text_label) {
          if (story) {
            href = `/content/${story.id}`
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
            token!.attrSet('href', `/content/${story.id}`)
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
      // Encrypted attachments: a permitted viewer gets the normal card marked
      // for client-side decryption on click. Everyone else gets the plaintext
      // 删减版 twin when the author uploaded one (amber card, tag 删减版), or a
      // gray nameless card when there is none — whatever shape the link had.
      const link_attachment = file_name ? ctx.options.attachments().find(item => item.file_name === file_name) : undefined
      const link_twin = link_attachment?.is_encrypted ? abridged_twin_of(ctx.options.attachments(), link_attachment.file_name) : null
      if (link_attachment?.is_encrypted) {
        if (! link_attachment.encryption_key && ! link_twin) {
          apply_chip_gaps(token!, tokens, idx, close_index, 'card')
          token!.meta = { ... token?.meta, encrypted_denied: true }
          const closing_denied = close_index !== - 1 ? tokens[close_index] : undefined
          if (closing_denied?.type === 'link_close') {
            closing_denied.meta = { ... closing_denied.meta, encrypted_denied: true }
          }
          return `<span class="link-card file-card encrypted-card-denied"><span class="file-card-icon iconify i-lucide:ban" aria-hidden="true"></span><span class="file-card-content"><span class="file-card-name">${CONTENT_ATTACHMENT_DENIED_TEXT}</span></span>`
        }
        if (! link_attachment.encryption_key && link_twin) {
          // Abridged substitution: the link points at the plaintext twin.
          token!.attrSet('href', ctx.options.static_url(link_twin.url))
          token!.attrJoin('class', 'file-card-encrypted')
          if (visible_label === null && close_index !== - 1) {
            apply_chip_gaps(token!, tokens, idx, close_index, 'card')
            token!.meta = {
              ... token?.meta,
              file_card: {
                icon: 'lucide:lock-keyhole',
                size: format_bytes(link_twin.file_size),
                name: attachment_base_name(link_twin.file_name),
                encrypted: true,
                abridged: true,
              } satisfies FileCardData,
            }
            const closing_abridged = tokens[close_index]
            if (closing_abridged?.type === 'link_close') {
              closing_abridged.meta = { ... closing_abridged.meta, file_card: token?.meta.file_card }
            }
            const rendered_abridged = default_link_rule(tokens, idx, options, env, self)
            return `${rendered_abridged}<span class="file-card-icon iconify i-lucide:lock-keyhole" aria-hidden="true"></span><span class="file-card-content"><span class="file-card-name">${md.utils.escapeHtml(attachment_base_name(link_twin.file_name))}</span>`
          }
        }
        else {
          token!.attrSet('data-encrypted', '')
          token!.attrJoin('class', 'file-card-encrypted')
          // The full/abridged toggle rides on the card for permitted viewers.
          if (link_twin) {
            token!.attrSet('data-twin-url', ctx.options.static_url(link_twin.url))
          }
        }
      }
      if (file_name && close_index !== - 1 && visible_label === null && ! token?.meta?.file_card) {
        const attachment = ctx.options.attachments().find(item => item.file_name === file_name)
        if (! attachment) {
          // A label-off link to a folder. Without this it would fall into the
          // silent dead-link branch below and vanish, since a folder has no
          // attachment row of its own.
          if (is_attachment_folder(ctx.options.attachments(), file_name)) {
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
        if (link_twin && attachment.is_encrypted)
          token!.attrJoin('class', 'file-card-toggleable')
        token!.meta = {
          ... token?.meta,
          file_card: {
            icon: attachment.is_encrypted ? 'lucide:lock-keyhole-open' : file_icon(attachment),
            size: attachment ? format_bytes(attachment.file_size) : '未知大小',
            name: label === null ? decrypted_attachment_name(attachment_base_name(file_name)) : null,
            encrypted: attachment.is_encrypted || undefined,
            twin_url: link_twin ? ctx.options.static_url(link_twin.url) : undefined,
          } satisfies FileCardData,
        }
        const closing = tokens[close_index]
        if (closing?.type === 'link_close') {
          closing.meta = { ... closing.meta, file_card: token?.meta.file_card }
        }
      }

      // Label-off Bilibili video links (`[](https://www.bilibili.com/video/BV…)`)
      // render as video cards; labeled links keep the normal-link rendering, the
      // same split as story cards. The href is recorded so the caller can fetch
      // cover/title metadata; until it arrives a placeholder card renders.
      const video_target = parse_bilibili_href(href)
      if (video_target && label === null && close_index !== - 1) {
        (env as RenderEnvironment).bilibili_hrefs.push(href)
        const card = ctx.options.video_card(href)
        if (card) {
          token!.attrSet('href', card.url)
        }
        token!.attrJoin('class', 'link-card video-card')
        if (! card) {
          token!.attrJoin('class', 'video-card-dead')
        }
        apply_chip_gaps(token!, tokens, idx, close_index, 'card')
        token!.meta = { ... token?.meta, video_card: true }
        const closing = tokens[close_index]
        if (closing?.type === 'link_close') {
          closing.meta = { ... closing.meta, video_card: true }
        }
        return `${default_link_rule(tokens, idx, options, env, self)}${video_card_inner(md, href, card)}`
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
      return `${rendered_link}<span class="link-card-icon chip-icon iconify i-lucide:link" aria-hidden="true"></span><span class="link-card-tag">链接</span><span class="link-card-label">`
    }
    return `${rendered_link}<span class="file-card-icon iconify i-${file_card.icon}" aria-hidden="true"></span><span class="file-card-content"><span class="file-card-name">${file_card.name ? md.utils.escapeHtml(file_card.name) : ''}`
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
      // Vertical block card like the video card: no trailing out icon; the
      // dead placeholder replaced the link with a span.
      return story_card.dead ? '</span>' : default_link_close_rule(tokens, idx, options, env, self)
    }
    if (tokens[idx]?.meta?.video_card) {
      // No trailing out icon: the card is a vertical block and the pink brand
      // strip already marks the destination.
      return default_link_close_rule(tokens, idx, options, env, self)
    }
    const file_card = tokens[idx]?.meta?.file_card as FileCardData | undefined
    if (! file_card) {
      return `</span><span class="link-card-open chip-icon iconify i-lucide:external-link" aria-hidden="true"></span>${default_link_close_rule(tokens, idx, options, env, self)}`
    }
    const encrypted_tag = file_card.encrypted ? `<span class="file-card-encrypted-tag">${file_card.abridged ? '机密附件·删减版' : '机密附件'}</span>` : ''
    // Permitted viewer with a plaintext twin: bottom bar toggles full/abridged.
    const toggle_bar = file_card.twin_url ? '<span class="encrypted-toggle-bar"><span class="encrypted-toggle" role="button" tabindex="0">查看删减版</span></span>' : ''
    return `</span><span class="file-card-size">${encrypted_tag}${file_card.size}</span></span><span class="link-card-open iconify i-lucide:external-link" aria-hidden="true"></span>${toggle_bar}${default_link_close_rule(tokens, idx, options, env, self)}`
  }
}
