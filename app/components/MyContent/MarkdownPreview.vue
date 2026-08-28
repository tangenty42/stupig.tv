<template>
  <!-- Invisible <MyIcon> instances that pull every v-html-only icon into the
       bundle; see compiled_icons below. -->
  <div class="hidden" aria-hidden="true">
    <MyIcon v-for="icon in compiled_icons" :key="icon" :name="icon" />
  </div>

  <!-- v-html is safe here: markdown-it runs with html disabled. -->
  <!-- eslint-disable-next-line vue/no-v-html -->
  <div
    v-if="body_markdown.trim()"
    ref="story_body"
    class="story-body"
    @click="on_preview_click"
    @keydown="on_preview_keydown"
    v-html="render_result.html"
  />
  <p v-else-if="emptyText" class="py-10 text-center text-sm text-slate-400 dark:text-slate-500">
    {{ emptyText }}
  </p>

  <ClientOnly>
    <MyImagePreview
      v-if="render_result.images.length"
      v-model:visible="preview_visible"
      :images="render_result.images"
      :initial-index="preview_index"
    />
  </ClientOnly>
</template>

<script setup lang="ts">
import type { BilibiliVideoCard } from '@shared/types/bilibili'
import type { ContentStoryAttachment, ContentStorySummary } from '@shared/types/content'
import { parse_bilibili_href } from '@shared/bilibili'
import { strip_front_matter } from '@shared/content-markdown'
import { story_rating, story_rating_rank } from '@shared/types/content'
import MarkdownIt from 'markdown-it'
import multimd_table from 'markdown-it-multimd-table'
import { cover_alt, file_icon, file_icon_names, story_front_cover_url } from '~/utils/content/attachment'
import { html_no_markdown_tags, html_table_tags } from '~/utils/content/html'

type AlertType = 'NOTE' | 'TIP' | 'IMPORTANT' | 'WARNING' | 'CAUTION'

interface RenderEnvironment {
  images: string[]
  /** Bilibili video hrefs seen while rendering, collected for the metadata fetch. */
  bilibili_hrefs: string[]
}

interface FileCardData {
  icon: string
  size: string
  /** Set when the link has no label; the card then renders the file name itself. */
  name: string | null
}

interface StoryCardMeta {
  /** Dead references render a muted placeholder span instead of a link. */
  dead: boolean
}

const props = withDefaults(defineProps<{
  markdown: string
  storyId?: number | null
  attachments?: ContentStoryAttachment[]
  emptyText?: string
  /** Known stories so `[](@title)` references render as story cards. */
  stories?: ContentStorySummary[]
}>(), {
  storyId: null,
  attachments: () => [],
  emptyText: '',
  stories: () => [],
})

const alert_icons: Record<AlertType, string> = {
  NOTE: 'info',
  TIP: 'lightbulb',
  IMPORTANT: 'badge-alert',
  WARNING: 'triangle-alert',
  CAUTION: 'octagon-alert',
}

const alert_labels: Record<AlertType, string> = {
  NOTE: '提示',
  TIP: 'TIP',
  IMPORTANT: '重要提示',
  WARNING: '警告',
  CAUTION: '注意',
}

// Every icon the rendered v-html can contain must be pre-registered here:
// Nuxt Icon only bundles statically visible <MyIcon> usages, and the
// `i-lucide:*` spans produced by the renderer rules are runtime strings it
// never sees. The hidden div above forces them into the local bundle; an
// icon missing from this list renders blank in the preview.
const compiled_icons = [
  ... file_icon_names.map(icon => `lucide:${icon}`),
  ... Object.values(alert_icons).map(icon => `lucide:${icon}`),
  'lucide:external-link',
  'lucide:chevron-left',
  'lucide:chevron-right',
  'lucide:tv',
  'lucide:play',
  'lucide:thumbs-up',
  'lucide:book-open',
  'lucide:book-x',
]

const static_url = useStaticUrl()
const api = useApi()
const body_markdown = computed(() => strip_front_matter(props.markdown))
const preview_visible = ref(false)
const preview_index = ref(0)

/** href -> card metadata; undefined = not fetched yet, null = fetch failed. */
const video_cards = shallowRef(new Map<string, BilibiliVideoCard | null>())

/** Case-insensitive title -> story lookup for `[](@title)` cards. */
const story_by_title = computed(() => {
  const map = new Map<string, ContentStorySummary>()
  for (const story of props.stories) {
    map.set(story.title.toLocaleLowerCase(), story)
  }
  return map
})

function absolutize(url: string) {
  // storyId null means the new-story editor, whose orphan uploads live under content/0/.
  // `@title` destinations are story references resolved by the link renderer.
  if (! url.startsWith('@') && ! url.includes('/') && ! url.startsWith('#') && ! /^[a-z][\w+.-]*:/i.test(url)) {
    // markdown-it percent-encodes the src (e.g. CJK file names), so decode it
    // before matching the attachment's stored (decoded) file name.
    const file_name = local_file_name(url)
    const version = file_name ? props.attachments.find(item => item.file_name === file_name)?.version : undefined
    const path = `/content/${props.storyId ?? 0}/${url}`
    return static_url(version ? `${path}?version=${version}` : path)
  }
  return url
}

function local_file_name(url: string) {
  if (! url || url.startsWith('@') || url.includes('/') || url.startsWith('#') || /^[a-z][\w+.-]*:/i.test(url)) {
    return null
  }
  try {
    const name = decodeURIComponent(url)
    return name.includes('/') ? null : name
  }
  catch {
    return url
  }
}

/** The markdown-it normalized `@title` destination is percent-encoded (e.g. `@%E6%96%B0...`); decode it back for title lookup. */
function decode_story_title(encoded: string) {
  try {
    return decodeURIComponent(encoded)
  }
  catch {
    return encoded
  }
}

const md = new MarkdownIt({ html: true, linkify: false })
  // autolabel adds an id derived from the caption text, which comes out empty
  // for CJK captions.
  .use(multimd_table, { rowspan: true, autolabel: false })

// VSCode-style source anchors: block elements carry their body line so the
// fullscreen editor's scroll sync can interpolate element-to-element. Nested
// renders (html wrappers re-rendering their inner markdown) report shifted
// line numbers, so only the top-level pass tags tokens.
let anchor_render_depth = 0
md.core.ruler.push('source_line_anchor', (state) => {
  if (anchor_render_depth > 0) {
    return true
  }
  for (const token of state.tokens) {
    if (token.map) {
      token.attrJoin('data-line', String(token.map[0]))
    }
  }
  return true
})

/** Inner HTML of a video card link, laid out like Bilibili's own card: a
   pink 哔哩哔哩 brand strip on top, then the full-width cover (stats and
   duration overlaid), title and uploader below. Covers live on hdslb.com,
   which 403s requests carrying a foreign Referer, hence
   referrerpolicy="no-referrer". */
function video_card_inner(href: string, card: BilibiliVideoCard | null | undefined) {
  const brand = `<span class="video-card-brand">${bilibili_logo_svg}<span class="video-card-brand-text">哔哩哔哩</span><span class="video-card-out iconify i-lucide:external-link" aria-hidden="true"></span></span>`
  if (! card) {
    const title = card === undefined ? '正在加载视频信息……' : href
    return `${brand}<span class="video-card-cover video-card-cover-empty"><span class="iconify i-lucide:tv" aria-hidden="true"></span></span><span class="video-card-content"><span class="video-card-title video-card-pending">${md.utils.escapeHtml(title)}</span></span>`
  }
  return `${brand}<span class="video-card-cover"><img class="built-in-img" src="${md.utils.escapeHtml(card.cover)}" alt="" loading="lazy" referrerpolicy="no-referrer"><span class="video-card-stats"><span class="video-card-stat"><span class="iconify i-lucide:play" aria-hidden="true"></span><span class="video-card-stat-value">${format_bilibili_count(card.views)}</span></span><span class="video-card-stat"><span class="iconify i-lucide:thumbs-up" aria-hidden="true"></span><span class="video-card-stat-value">${format_bilibili_count(card.likes)}</span></span></span><span class="video-card-duration">${format_bilibili_duration(card.duration)}</span></span><span class="video-card-content"><span class="video-card-title">${md.utils.escapeHtml(card.title)}</span><span class="video-card-uploader"><span class="video-card-up">UP</span>${md.utils.escapeHtml(card.uploader)}</span></span>`
}

/** Inner HTML of a story reference card, laid out like the video card: a
   primary 蠢猪档案 brand strip on top, then an optional full-width cover,
   then the title and an optional description line. The rating shows as a
   large, translucent tier SVG badge on its own line at the bottom right of
   the card content, so it never overlaps the text (imgs/ratings/1-5.svg,
   1=夯 … 5=拉完了; rank r maps to file 6-r, unrated 难评 has none). Dead
   references (target story gone) render a muted placeholder cover with the
   raw title. */
function story_card_inner(story: ContentStorySummary | null, fallback_title = '') {
  // Dead references are spans without navigation, so they get no out icon.
  const out = story ? '<span class="story-card-out iconify i-lucide:external-link" aria-hidden="true"></span>' : ''
  const brand = `<span class="story-card-brand"><span class="iconify i-lucide:book-open" aria-hidden="true"></span><span class="story-card-brand-text">蠢猪档案</span>${out}</span>`
  if (! story) {
    return `${brand}<span class="story-card-cover story-card-cover-empty"><span class="iconify i-lucide:book-x" aria-hidden="true"></span></span><span class="story-card-content"><span class="story-card-title">${md.utils.escapeHtml(fallback_title)}</span></span>`
  }
  const rank = story_rating_rank(story.labels)
  const rating = rank
    ? `<img class="built-in-img story-card-rating" src="${static_url(`imgs/ratings/${6 - rank}.svg`)}" alt="${md.utils.escapeHtml(story_rating(story.labels))}" loading="lazy" referrerpolicy="no-referrer">`
    : ''
  const cover = story.cover
    ? `<span class="story-card-cover"><img class="built-in-img" src="${md.utils.escapeHtml(story_front_cover_url(static_url, story.cover, story.id))}" alt="${md.utils.escapeHtml(cover_alt(story.cover, story.cover_label, story.title))}" loading="lazy" referrerpolicy="no-referrer"></span>`
    : ''
  const desc = story.desc ? `<span class="story-card-desc">${md.utils.escapeHtml(story.desc)}</span>` : ''
  return `${brand}${cover}<span class="story-card-content"><span class="story-card-title">${md.utils.escapeHtml(story.title)}</span>${desc}${rating}</span>`
}
// Marker line: `[!NOTE]`, optionally followed by a custom title on the same
// line (trimmed in the rule below, so no leading-space handling here).
const alert_pattern = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\](.*)$/

md.core.ruler.after('block', 'severity_blockquotes', (state) => {
  for (let index = 0; index < state.tokens.length - 3; index ++) {
    const opening = state.tokens[index]
    const paragraph_open = state.tokens[index + 1]
    const marker = state.tokens[index + 2]
    const paragraph_close = state.tokens[index + 3]
    if (opening?.type !== 'blockquote_open'
      || paragraph_open?.type !== 'paragraph_open'
      || marker?.type !== 'inline'
      || paragraph_close?.type !== 'paragraph_close') {
      continue
    }

    // Only the first line of the first paragraph can be the marker; any
    // following lines stay as the alert body.
    const content = marker.content.trim()
    const first_line_end = content.indexOf('\n')
    const first_line = first_line_end === - 1 ? content : content.slice(0, first_line_end)
    const match = alert_pattern.exec(first_line)
    if (! match) {
      continue
    }

    opening.meta = {
      ... opening.meta,
      alert_type: match[1] as AlertType,
      alert_title: match[2]?.trim() || null,
    }
    if (first_line_end === - 1) {
      state.tokens.splice(index + 1, 3)
    }
    else {
      // Strip the marker line; the inline pass parses the rest into children.
      marker.content = content.slice(first_line_end + 1)
    }
  }
})

md.core.ruler.after('inline', 'image_carousels', (state) => {
  const is_break = (type: string) => type === 'softbreak' || type === 'hardbreak'
  const clone_token = (token: InstanceType<typeof state.Token>) => Object.assign(
    new state.Token(token.type, token.tag, token.nesting),
    token,
    { attrs: token.attrs?.map(attribute => [... attribute]) ?? null },
  )

  for (let index = 0; index < state.tokens.length - 2;) {
    const paragraph_open = state.tokens[index]
    const inline = state.tokens[index + 1]
    const paragraph_close = state.tokens[index + 2]
    const children = inline?.children ?? []
    const segments: { carousel: boolean, children: typeof children }[] = []
    let normal_start = 0

    if (paragraph_open?.type !== 'paragraph_open'
      || inline?.type !== 'inline'
      || paragraph_close?.type !== 'paragraph_close') {
      index ++
      continue
    }

    for (let child_index = 0; child_index < children.length;) {
      if (children[child_index]?.type !== 'image') {
        child_index ++
        continue
      }

      let run_end = child_index + 1
      let image_count = 1
      while (is_break(children[run_end]?.type ?? '') && children[run_end + 1]?.type === 'image') {
        run_end += 2
        image_count ++
      }

      if (image_count < 2) {
        child_index = run_end
        continue
      }

      const before = children.slice(normal_start, child_index)
      while (before.length && is_break(before.at(- 1)?.type ?? '')) {
        before.pop()
      }
      if (before.length) {
        segments.push({ carousel: false, children: before })
      }
      segments.push({
        carousel: true,
        children: children.slice(child_index, run_end).filter(child => child.type === 'image'),
      })

      normal_start = run_end
      while (is_break(children[normal_start]?.type ?? '')) {
        normal_start ++
      }
      child_index = normal_start
    }

    if (! segments.some(segment => segment.carousel)) {
      index += 3
      continue
    }

    const after = children.slice(normal_start)
    if (after.length) {
      segments.push({ carousel: false, children: after })
    }

    const replacement = segments.flatMap((segment) => {
      const opening = clone_token(paragraph_open)
      const content = clone_token(inline)
      const closing = clone_token(paragraph_close)
      content.children = segment.children
      return [opening, content, closing]
    })
    state.tokens.splice(index, 3, ... replacement)
    index += replacement.length
  }

  const image_paragraph_at = (index: number) => {
    const paragraph_open = state.tokens[index]
    const inline = state.tokens[index + 1]
    const paragraph_close = state.tokens[index + 2]
    const children = inline?.children ?? []
    const image_count = children.filter(child => child.type === 'image').length
    const is_image_only = image_count > 0
      && children.every(child => ['image', 'softbreak', 'hardbreak'].includes(child.type))

    return paragraph_open?.type === 'paragraph_open'
      && inline?.type === 'inline'
      && paragraph_close?.type === 'paragraph_close'
      && is_image_only
      ? { paragraph_open, inline, paragraph_close, image_count }
      : null
  }

  for (let index = 0; index < state.tokens.length - 2; index ++) {
    const paragraph = image_paragraph_at(index)
    if (! paragraph || paragraph.image_count < 1) {
      continue
    }

    paragraph.paragraph_open.attrJoin('class', 'image-carousel')
    paragraph.paragraph_open.meta = { ... paragraph.paragraph_open.meta, carousel: true }
    paragraph.paragraph_close.meta = { ... paragraph.paragraph_close.meta, carousel: true }
    for (const child of paragraph.inline.children ?? []) {
      if (is_break(child.type)) {
        child.type = 'text'
        child.content = ''
      }
      else if (child.type === 'image') {
        child.meta = { ... child.meta, carousel: true }
      }
    }
  }
})

interface ChipToken {
  type: string
  attrJoin: (name: string, value: string) => void
}

// Inline chips (inline code, file cards) get side margins to separate them
// from neighboring text, but at a line edge the margin would break the
// text's left/right alignment, so skip it when the chip is the first/last
// inline content of a line. Only hard breaks count: a softbreak renders as
// a space, so a chip after one is still mid-line. Link boundaries are
// transparent: a link starting with a chip still counts as a line edge.
// Each chip type gets its own class pair (chip-code-gap-l, chip-card-gap-l,
// ...) so their styles can be tuned independently.
function at_line_edge(sibling?: { type: string }) {
  return ! sibling || ['hardbreak', 'link_open', 'link_close'].includes(sibling.type)
}

function apply_chip_gaps(token: ChipToken, tokens: ChipToken[], idx: number, end_idx = idx, type = 'code') {
  if (! at_line_edge(tokens[idx - 1])) {
    token.attrJoin('class', `chip-${type}-gap-l`)
  }
  if (! at_line_edge(tokens[end_idx + 1])) {
    token.attrJoin('class', `chip-${type}-gap-r`)
  }
}

const default_blockquote_rule = md.renderer.rules.blockquote_open
  ?? ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options))
md.renderer.rules.blockquote_open = (tokens, idx, options, env, self) => {
  const alert_type = tokens[idx]?.meta?.alert_type as AlertType | undefined
  if (! alert_type) {
    return default_blockquote_rule(tokens, idx, options, env, self)
  }
  const token = tokens[idx]!
  const line_attr = token.map ? ` data-line="${token.map[0]}"` : ''
  const icon = alert_icons[alert_type]
  const alert_title = token.meta?.alert_title as string | null | undefined
  const title = alert_title ? md.utils.escapeHtml(alert_title) : alert_labels[alert_type]
  return `<blockquote class="markdown-alert markdown-alert-${alert_type.toLowerCase()}"${line_attr}><p class="markdown-alert-title"><span class="iconify i-lucide:${icon}" aria-hidden="true"></span><span>${title}</span></p>\n`
}

const default_image_rule = md.renderer.rules.image
  ?? ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options))
md.renderer.rules.image = (tokens, idx, options, env, self) => {
  const token = tokens[idx]
  const src = token?.attrGet('src')
  if (src) {
    const resolved_src = absolutize(src)
    const render_env = env as RenderEnvironment
    const preview_image_index = render_env.images.push(resolved_src) - 1
    token!.attrSet('src', resolved_src)
    token!.attrSet('data-preview-index', String(preview_image_index))
    token!.attrSet('role', 'button')
    token!.attrSet('tabindex', '0')
    token!.attrSet('aria-label', `预览图片：${token?.content || local_file_name(src) || '图片'}`)
  }
  const rendered_image = default_image_rule(tokens, idx, options, env, self)
  // The frame anchors the "点击查看长图" cover, revealed by data-cropped
  // when the min-w/object-crop rule actually clips a tall image.
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

const default_link_rule = md.renderer.rules.link_open
  ?? ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options))
md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  const token = tokens[idx]
  let href = token?.attrGet('href')
  if (href) {
    const has_text_label = tokens[idx + 1]?.type === 'text' && tokens[idx + 2]?.type === 'link_close'
    const close_index = has_text_label ? idx + 2 : (tokens[idx + 1]?.type === 'link_close' ? idx + 1 : - 1)

    // `[](@title)` (label-off) renders as a story card; a labeled
    // `[text](@title)` keeps the normal-link rendering with the story URL
    // resolved, so it looks like any other link.
    if (href.startsWith('@')) {
      const story_title = decode_story_title(href.slice(1))
      const story = story_by_title.value.get(story_title.toLocaleLowerCase())
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
          return `${default_link_rule(tokens, idx, options, env, self)}${story_card_inner(story)}`
        }
        // Dead reference: the target story is gone; render a muted placeholder.
        return `<span class="link-card story-card story-card-dead">${story_card_inner(null, story_title)}`
      }
    }

    // A label-off link (`[](file.sql)`) has no text token: link_close
    // follows link_open directly and the card renders the file name itself.
    const label = has_text_label ? tokens[idx + 1]!.content : null
    const file_name = local_file_name(href)
    token!.attrSet('href', absolutize(href))
    token!.attrSet('target', '_blank')
    token!.attrSet('rel', 'noopener noreferrer')
    token!.attrJoin('class', 'link link-card')
    if (file_name && close_index !== - 1 && (label === null || label === file_name)) {
      const attachment = props.attachments.find(item => item.file_name === file_name)
      if (! attachment && label === null) {
        // Label-off link to a file this story doesn't have: render nothing.
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
          icon: file_icon(attachment ?? { file_name, mime_type: null }),
          size: attachment ? format_bytes(attachment.file_size) : '未知大小',
          name: label === null ? file_name : null,
        } satisfies FileCardData,
      }
      const closing = tokens[close_index]
      if (closing?.type === 'link_close') {
        closing.meta = { ... closing.meta, file_card: token?.meta.file_card }
      }
    }

    // Label-off Bilibili video links (`[](https://www.bilibili.com/video/BV…)`)
    // render as video cards; labeled links keep the normal-link rendering, the
    // same split as story cards. The href is recorded so the watcher below can
    // fetch cover/title metadata; until it arrives a placeholder card renders.
    const video_target = parse_bilibili_href(href)
    if (video_target && label === null && close_index !== - 1) {
      (env as RenderEnvironment).bilibili_hrefs.push(href)
      const card = video_cards.value.get(href)
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
      return `${default_link_rule(tokens, idx, options, env, self)}${video_card_inner(href, card)}`
    }
  }
  const rendered_link = default_link_rule(tokens, idx, options, env, self)
  const file_card = token?.meta?.file_card as FileCardData | undefined
  if (! file_card) {
    // Plain link: wrap the label so it can truncate; link_close closes the
    // span and appends the out icon at the END of the label.
    return `${rendered_link}<span class="link-card-label">`
  }
  return `${rendered_link}<span class="file-card-icon iconify i-lucide:${file_card.icon}" aria-hidden="true"></span><span class="file-card-content"><span class="file-card-name">${file_card.name ? md.utils.escapeHtml(file_card.name) : ''}`
}

const default_link_close_rule = md.renderer.rules.link_close
  ?? ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options))
md.renderer.rules.link_close = (tokens, idx, options, env, self) => {
  if (tokens[idx]?.meta?.silent_link) {
    return ''
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
    return `</span><span class="link-card-open iconify i-lucide:external-link" aria-hidden="true"></span>${default_link_close_rule(tokens, idx, options, env, self)}`
  }
  return `</span><span class="file-card-size">${file_card.size}</span></span><span class="link-card-open iconify i-lucide:external-link" aria-hidden="true"></span>${default_link_close_rule(tokens, idx, options, env, self)}`
}

const default_code_inline_rule = md.renderer.rules.code_inline
  ?? ((tokens, idx, _options, _env, self) => `<code${self.renderAttrs(tokens[idx]!)}>${md.utils.escapeHtml(tokens[idx]!.content)}</code>`)
md.renderer.rules.code_inline = (tokens, idx, options, env, self) => {
  apply_chip_gaps(tokens[idx]!, tokens, idx)
  return default_code_inline_rule(tokens, idx, options, env, self)
}

// A carousel can't stay a <p>: its prev/next buttons must be block-level
// siblings of the scroll strip, and interactive content isn't allowed inside
// a <p> anyway. Hoist it into a .carousel-shell <div> with the two nav
// buttons; the scroll strip keeps the .image-carousel class and behavior.
md.renderer.rules.paragraph_open = (tokens, idx, options, env, self) => {
  const token = tokens[idx]!
  if (token.meta?.carousel) {
    return `<div class="carousel-shell"><button type="button" class="carousel-nav carousel-prev" aria-label="上一张"><span class="iconify i-lucide:chevron-left" aria-hidden="true"></span></button><div${self.renderAttrs(token)}>`
  }
  return self.renderToken(tokens, idx, options)
}

md.renderer.rules.paragraph_close = (tokens, idx, options, env, self) => {
  const token = tokens[idx]!
  if (token.meta?.carousel) {
    return `</div><button type="button" class="carousel-nav carousel-next" aria-label="下一张"><span class="carousel-hint-text" aria-hidden="true">右边还有 · 可左右滚动</span><span class="iconify i-lucide:chevron-right" aria-hidden="true"></span></button></div>\n`
  }
  return self.renderToken(tokens, idx, options)
}

// Code blocks get an inner scroll wrapper so the <pre> itself can stay
// overflow-hidden: the scrollbar then sits clear of the rounded border, the
// same outer-frame/inner-scroller layering as the CodeMirror editor.
md.renderer.rules.fence = (tokens, idx) => {
  const token = tokens[idx]!
  const info = token.info ? md.utils.unescapeAll(token.info).trim() : ''
  const lang_name = info ? md.utils.escapeHtml(info.split(/\s+/g)[0] ?? '') : ''
  const lang_class = lang_name ? ` class="language-${lang_name}"` : ''
  const line_attr = token.map ? ` data-line="${token.map[0]}"` : ''
  return `<pre${line_attr}><div class="code-scroll"><code${lang_class}>${md.utils.escapeHtml(token.content)}</code></div></pre>\n`
}

md.renderer.rules.code_block = (tokens, idx) => {
  const token = tokens[idx]!
  const line_attr = token.map ? ` data-line="${token.map[0]}"` : ''
  return `<pre${line_attr}><div class="code-scroll"><code>${md.utils.escapeHtml(token.content)}</code></div></pre>\n`
}

// HTML wrappers that are allowed to contain markdown: every element except
// raw-text/code/embedded ones. Mirror of the editor's nested-language list.

// A wrapper whose content is entirely markdown (no blank lines, or the block
// parser would have split it) arrives as one html_block token — but one token
// can also glue several SIBLING elements together (e.g. two `<center>` lines
// with no blank line between them), so it must be split into complete
// top-level elements with same-tag nesting matched. A single lazy
// `<tag>...</tag>` match would span siblings and strand their close tags.
const html_element_open_pattern = /^<([a-z][\w-]*)\b([^>]*?)(\/?)>/i

interface HtmlWrapperChunk {
  tag: string
  attrs: string
  inner: string
  /** Exact source text of the whole element, for raw passthrough. */
  source: string
  closed: boolean
}

function split_html_wrappers(content: string): HtmlWrapperChunk[] | null {
  const chunks: HtmlWrapperChunk[] = []
  let rest = content
  while (rest.trim()) {
    rest = rest.replace(/^\s+/, '')
    const open = html_element_open_pattern.exec(rest)
    if (! open) {
      return null
    }
    const tag = open[1]!.toLowerCase()
    if (open[3]) { // self-closing: nothing to parse inside
      chunks.push({ tag, attrs: '', inner: '', source: open[0], closed: false })
      rest = rest.slice(open[0].length)
      continue
    }
    const boundary = new RegExp(String.raw`<${tag}\b[^>]*>|<\/${tag}\s*>`, 'gi')
    boundary.lastIndex = open[0].length
    let depth = 1
    let close: RegExpExecArray | null = null
    for (let match = boundary.exec(rest); match !== null; match = boundary.exec(rest)) {
      if (match[0].startsWith('</')) {
        depth --
      }
      else if (! match[0].endsWith('/>')) {
        depth ++
      }
      if (depth === 0) {
        close = match
        break
      }
    }
    if (! close) {
      return null
    }
    const end = close.index + close[0].length
    chunks.push({ tag, attrs: open[2]!, inner: rest.slice(open[0].length, close.index), source: rest.slice(0, end), closed: true })
    rest = rest.slice(end)
  }
  return chunks
}

// HTML wrapper indentation is cosmetic whitespace, not markdown structure.
// Without this, `    [](tmp.jpg)` inside a wrapper would parse as an indented
// code block instead of a link/file card.
function dedent_html_inner(text: string) {
  const lines = text.split('\n')
  let min_indent = Infinity
  for (const line of lines) {
    if (! line.trim()) {
      continue
    }
    const leading = /^[ \t]*/.exec(line)![0].length
    min_indent = Math.min(min_indent, leading)
  }
  if (! Number.isFinite(min_indent) || min_indent === 0) {
    return text.trim()
  }
  return lines.map(line => line.slice(min_indent)).join('\n').trim()
}

const default_html_block_rule = md.renderer.rules.html_block
  ?? ((tokens, idx) => tokens[idx]!.content)
md.renderer.rules.html_block = (tokens, idx, options, env, self) => {
  const token = tokens[idx]!
  const chunks = split_html_wrappers(token.content)
  if (! chunks) {
    return default_html_block_rule(tokens, idx, options, env, self)
  }
  const line_attr = token.map ? ` data-line="${token.map[0]}"` : ''
  return `${chunks.map((chunk) => {
    if (! chunk.closed || html_no_markdown_tags.has(chunk.tag) || html_table_tags.has(chunk.tag)) {
      return chunk.source
    }
    // Reuse the same env so nested markdown (images, cards) feeds the
    // preview lightbox through the shared images array.
    anchor_render_depth ++
    try {
      const inner_html = md.render(dedent_html_inner(chunk.inner), env)
      return `<${chunk.tag}${chunk.attrs}${line_attr}>${inner_html}</${chunk.tag}>`
    }
    finally {
      anchor_render_depth --
    }
  }).join('\n')}\n`
}

const render_result = computed(() => {
  const environment: RenderEnvironment = { images: [], bilibili_hrefs: [] }
  return {
    html: md.render(body_markdown.value, environment),
    images: environment.images,
    bilibili_hrefs: environment.bilibili_hrefs,
  }
})

// Metadata for the video cards found in the last render. Client-only so SSR
// and hydration both render the same placeholder card; the server caches
// upstream responses, so repeat previews of one story stay cheap.
watch(() => render_result.value.bilibili_hrefs, async (hrefs) => {
  if (! import.meta.client) {
    return
  }
  const missing = [... new Set(hrefs)].filter(href => ! video_cards.value.has(href))
  if (! missing.length) {
    return
  }
  try {
    const cards = await api.content.get_bilibili_video_cards(missing)
    const next = new Map(video_cards.value)
    for (const [href, card] of Object.entries(cards)) {
      next.set(href, card)
    }
    video_cards.value = next
  }
  catch {
    // The request itself failed (offline, server down): keep the
    // placeholder cards; the next render change retries the fetch.
  }
}, { immediate: true })

const story_body = useTemplateRef<HTMLElement>('story_body')

// Wire each carousel directly: its own scroll listener plus direct button
// clicks. No event delegation and no `disabled` toggling, so a button can
// never get stuck inert — visibility is driven purely by a data attribute
// recomputed from the live scroll position.
function update_carousel_navs(carousel: HTMLElement) {
  const shell = carousel.closest('.carousel-shell')
  const prev = shell?.querySelector<HTMLElement>('.carousel-prev')
  const next = shell?.querySelector<HTMLElement>('.carousel-next')
  if (! prev || ! next) {
    return
  }
  const max_left = carousel.scrollWidth - carousel.clientWidth
  prev.dataset.on = String(carousel.scrollLeft > 1)
  next.dataset.on = String(carousel.scrollLeft < max_left - 1)
}

// The fade width lives in CSS (--carousel-fade-width on .carousel-shell);
// resolve it to px here so nav jumps share that single source.
function carousel_fade_width(shell: HTMLElement) {
  const raw = getComputedStyle(shell).getPropertyValue('--carousel-fade-width').trim()
  if (raw.endsWith('rem')) {
    return parseFloat(raw) * parseFloat(getComputedStyle(document.documentElement).fontSize)
  }
  return parseFloat(raw) || 0
}

function setup_carousel(carousel: HTMLElement) {
  const shell = carousel.closest<HTMLElement>('.carousel-shell')
  if (! shell || shell.dataset.wired) {
    return
  }
  shell.dataset.wired = 'true'
  const update = () => update_carousel_navs(carousel)
  // Scroll to the start of the next/previous image rather than a raw
  // viewport step, so an image always lands at the strip's leading edge.
  // The landing target shifts back by the edge-fade width so the image
  // clears the faded zone instead of arriving underneath it, and the
  // search pivots on that same fade edge (active only once scrolled).
  const scroll_to_image = (direction: number) => {
    const max_left = carousel.scrollWidth - carousel.clientWidth
    const fade = carousel_fade_width(shell)
    const pivot = carousel.scrollLeft + (carousel.scrollLeft > 1 ? fade : 0)
    const offsets = [... carousel.children].map(child =>
      (child as HTMLElement).offsetLeft - carousel.offsetLeft)
    const target = direction > 0
      ? offsets.find(offset => offset > pivot + 1)
      : [... offsets].reverse().find(offset => offset < pivot - 1)
    const left = target === undefined
      ? (direction > 0 ? max_left : 0)
      : Math.max(target - fade, 0)
    carousel.scrollTo({ left: Math.min(left, max_left), behavior: 'smooth' })
  }
  const prev_button = shell.querySelector('.carousel-prev')
  const next_button = shell.querySelector<HTMLElement>('.carousel-next')
  prev_button?.addEventListener('click', () => scroll_to_image(- 1))
  next_button?.addEventListener('click', () => scroll_to_image(1))
  // First-scroll nudge: the next button shows a "右边还有" label until the
  // carousel is scrolled once, then data-hint is dropped for good.
  if (next_button) {
    next_button.dataset.hint = 'true'
  }
  carousel.addEventListener('scroll', () => {
    if (next_button?.dataset.hint) {
      delete next_button.dataset.hint
    }
    update()
  }, { passive: true })
  // At setup the images are usually still loading, so the strip has no
  // overflow yet and no scroll event fires when its scrollWidth grows as
  // they load. Recompute whenever the strip or its items resize.
  const observer = new ResizeObserver(update)
  observer.observe(carousel)
  for (const item of carousel.children) {
    observer.observe(item)
  }
  update()
}

function refresh_carousel_navs() {
  story_body.value?.querySelectorAll<HTMLElement>('.image-carousel').forEach(setup_carousel)
}

// Wrap the flat rendered blocks into NESTED sections: a heading opens a
// section inside the nearest lower-level heading's section (h2 under h1,
// ...), so a pinned chapter title survives its subsections and is pushed
// away only by the next same-or-higher-level heading.
function wrap_heading_sections() {
  const body = story_body.value
  if (! body) {
    return
  }
  const open: { level: number, section: HTMLElement }[] = []
  for (const child of [... body.children]) {
    const match = /^H([1-6])$/.exec(child.tagName)
    if (! match) {
      open.at(- 1)?.section.append(child)
      continue
    }
    const level = Number(match[1])
    while (open.length && open.at(- 1)!.level >= level) {
      open.pop()
    }
    const section = document.createElement('section')
    section.className = 'story-section'
    const parent = open.at(- 1)?.section
    if (parent) {
      parent.append(section)
    }
    else {
      child.before(section)
    }
    section.append(child)
    open.push({ level, section })
  }
}

// A pinned heading starts exiting when its section's bottom edge reaches it,
// but collapsed margins put that edge ahead of the next heading's box, so the
// exit visibly starts too early. The sticky constraint uses the section's
// CONTENT box (padding doesn't move it) against the heading's bottom MARGIN
// edge, so extend the flow with a spacer: swallow the leading collapsed
// margin, add the gap plus the heading's bottom margin as height, and pull
// the layout back with an equal negative section margin. The incoming
// heading then physically pushes the pinned one away. Deepest sections
// first: once a leaf's edge is extended, ancestors sharing the boundary
// measure a negative gap and skip.
function compensate_section_push() {
  const body = story_body.value
  if (! body) {
    return
  }
  // Both offsetTop and getBoundingClientRect report a pinned sticky
  // heading's displaced visual position, which explodes the gap whenever
  // this runs while scrolled deep (observer refire, editor re-render,
  // restored scroll, sync refetch). Suspend sticky for the measurement;
  // the synchronous block never paints the intermediate state.
  body.classList.add('measuring')
  try {
    const sections = [... body.querySelectorAll<HTMLElement>('.story-section')].reverse()
    for (const section of sections) {
      let boundary: Element | null = null
      for (let el: Element | null = section; el && el !== body; el = el.parentElement) {
        if (el.nextElementSibling) {
          boundary = el.nextElementSibling
          break
        }
      }
      const heading = section.firstElementChild
      const next_heading = boundary?.firstElementChild
      if (! (heading instanceof HTMLElement)
        || ! (next_heading instanceof HTMLElement)
        || ! /^H[1-6]$/.test(next_heading.tagName)) {
        continue
      }
      const gap = next_heading.offsetTop - (section.offsetTop + section.offsetHeight)
      if (gap <= 1) {
        continue
      }
      const heading_mb = parseFloat(getComputedStyle(heading).marginBottom) || 0
      const next_mt = parseFloat(getComputedStyle(next_heading).marginTop) || 0
      const before = section.offsetTop + section.offsetHeight
      const spacer = document.createElement('div')
      section.append(spacer)
      spacer.style.marginTop = `${before - spacer.offsetTop}px`
      spacer.style.height = `${gap + heading_mb}px`
      section.style.marginBottom = `${- (heading_mb + next_mt)}px`
    }
  }
  finally {
    body.classList.remove('measuring')
  }
}

// Stack pinned headings by their ancestor sections' measured heading
// heights: h2 docks below the pinned h1, h3 below h1+h2, ... Measured (not
// fixed rem) so wrapped multi-line titles still stack right; rerun on
// resize.
function layout_heading_offsets() {
  const body = story_body.value
  if (! body) {
    return
  }
  for (const heading of body.querySelectorAll<HTMLElement>('.story-section > :is(h1, h2, h3, h4, h5, h6)')) {
    let offset = 0
    // Only our own .story-section wrappers count as nesting ancestors; the
    // page also wraps the preview in plain <section> elements.
    let ancestor_section = heading.parentElement?.parentElement
    while (ancestor_section?.classList.contains('story-section')) {
      const ancestor = ancestor_section.firstElementChild
      if (ancestor instanceof HTMLElement) {
        offset += ancestor.offsetHeight
      }
      ancestor_section = ancestor_section.parentElement
    }
    heading.style.top = offset ? `calc(var(--app-header-height, 0px) + ${offset}px)` : ''
  }
}

// The min-w/min-h/object-crop rule clips tall (and now wide) images without
// leaving a marker in the DOM, so detect real clipping from the rendered box
// vs the natural ratio and tag the frame to reveal its "点击查看完整图片" cover.
// The rendered box changes with the viewport (window resize, the carousel's
// max-w-full clamp), so each framed image keeps a ResizeObserver instead of
// being measured once; the observer's initial fire doubles as the first
// measurement.
let crop_observer: ResizeObserver | null = null
function mark_cropped_images() {
  crop_observer?.disconnect()
  crop_observer = null
  const images = story_body.value?.querySelectorAll<HTMLImageElement>('.img-frame > img')
  if (! images?.length) {
    return
  }
  const update = (image: HTMLImageElement) => {
    if (! image.naturalWidth) {
      return
    }
    const frame = image.parentElement
    const ratio = image.naturalHeight / image.naturalWidth
    const cropped_tall = image.clientWidth * ratio - image.clientHeight > 1
    const cropped_wide = image.clientHeight / ratio - image.clientWidth > 1
    frame?.toggleAttribute('data-cropped', cropped_tall || cropped_wide)
    const cover = frame?.querySelector('.long-img-cover')
    if (cover) {
      cover.textContent = '点击查看完整图片'
    }
  }
  crop_observer = new ResizeObserver(entries =>
    entries.forEach(entry => update(entry.target as HTMLImageElement)))
  for (const image of images) {
    image.addEventListener('load', () => update(image), { once: true })
    crop_observer.observe(image)
  }
}

// Set up every carousel once the rendered HTML is in the DOM, and whenever
// it re-renders.
watch(render_result, () => {
  nextTick(() => {
    wrap_heading_sections()
    compensate_section_push()
    layout_heading_offsets()
    refresh_carousel_navs()
    mark_cropped_images()
    observe_story_body()
  })
}, { flush: 'post' })

// A v-show-hidden preview (the editor's preview tab) reports all-zero rects
// at mount, so the measured compensation and dock offsets silently skip.
// Re-measure whenever the body gains real size; both are idempotent, so the
// initial fire and image-load resizes are harmless.
let body_observer: ResizeObserver | null = null
function observe_story_body() {
  body_observer?.disconnect()
  body_observer = null
  if (story_body.value) {
    body_observer = new ResizeObserver(() => {
      compensate_section_push()
      layout_heading_offsets()
    })
    body_observer.observe(story_body.value)
  }
}

onMounted(() => {
  nextTick(() => {
    wrap_heading_sections()
    compensate_section_push()
    layout_heading_offsets()
    refresh_carousel_navs()
    mark_cropped_images()
    observe_story_body()
  })
  window.addEventListener('resize', layout_heading_offsets)
})

onUnmounted(() => {
  body_observer?.disconnect()
  crop_observer?.disconnect()
  window.removeEventListener('resize', layout_heading_offsets)
})

function preview_image_from_event(event: Event) {
  if (! (event.target instanceof HTMLElement)) {
    return null
  }
  return event.target.closest<HTMLImageElement>('img[data-preview-index]')
}

function open_image_preview(image: HTMLImageElement) {
  const index = Number(image.dataset.previewIndex)
  if (! Number.isInteger(index) || index < 0 || index >= render_result.value.images.length) {
    return
  }
  preview_index.value = index
  preview_visible.value = true
}

function on_preview_click(event: MouseEvent) {
  const image = preview_image_from_event(event)
  if (image) {
    open_image_preview(image)
  }
}

function on_preview_keydown(event: KeyboardEvent) {
  if (event.key !== 'Enter' && event.key !== ' ') {
    return
  }
  const image = preview_image_from_event(event)
  if (image) {
    event.preventDefault()
    open_image_preview(image)
  }
}
</script>

<style scoped>
.story-body {
  @apply leading-7 text-slate-700 [overflow-wrap:anywhere] dark:text-slate-300;
}

/* Headings pin below the fixed app header while their section scrolls under
   them. JS nests sections by heading level and measures stacked offsets, so a
   subsection title docks below its pinned chapter title and only a
   same-or-higher-level heading pushes it away. Higher levels paint above
   lower ones, so an exiting heading dissolves under its pinned ancestor's
   background instead of veiling it. The padding sits inside the background,
   doubling as part of the vertical spacing. Like the app header, the
   background is translucent with a backdrop blur, so content scrolling
   underneath blurs out fluently instead of being clipped mid-glyph. */
.story-body :deep(:is(h1, h2, h3, h4, h5, h6)) {
  @apply sticky z-10 mb-2 bg-white/80 py-2 font-bold text-slate-800 backdrop-blur-md dark:bg-slate-900/80 dark:text-slate-100;
  top: var(--app-header-height, 0px);
  /* Full-bleed: the frosted bar spans the viewport while the compensating
     padding keeps the title text aligned with the content column. */
  margin-inline: calc(50% - 50vw);
  padding-inline: calc(50vw - 50%);
}

/* compensate_section_push() measures flow positions with pinning suspended. */
.story-body.measuring :deep(:is(h1, h2, h3, h4, h5, h6)) {
  position: static;
}

.story-body :deep(h1) {
  @apply z-30 mt-8;
}

.story-body :deep(h2) {
  @apply z-[29] mt-6;
}

.story-body :deep(h3) {
  @apply z-[28] mt-5 text-lg;
}

.story-body :deep(h4) {
  @apply z-[27] mt-4;
}

.story-body :deep(h5) {
  @apply z-[26] mt-3 text-sm;
}

.story-body :deep(h6) {
  @apply z-[25] mt-2 text-xs;
}

/* Markdown source markers, one per level, tinted back so
   they read as decoration rather than part of the title. */
.story-body :deep(:is(h1, h2, h3, h4, h5, h6))::before {
  @apply mr-2 select-none font-bold text-slate-300 dark:text-slate-600;
}

.story-body :deep(h1)::before {
  content: '#';
}

.story-body :deep(h2)::before {
  content: '##';
}

.story-body :deep(h3)::before {
  content: '###';
}

.story-body :deep(h4)::before {
  content: '####';
}

.story-body :deep(h5)::before {
  content: '#####';
}

.story-body :deep(h6)::before {
  content: '######';
}

.story-body :deep(p) {
  @apply my-2;
}

/* After the section wrapping, former top-level blocks live one level deeper;
   keep their roomier margins in both positions. */
.story-body :deep(> p),
.story-body :deep(section > p) {
  @apply my-6;
}

/* Abstract card chrome shared by plain links, file cards and story cards:
   dashed border, tinted background, small line height so the card embeds
   into the text line, and a hover state that darkens the whole card
   (brightness, so a cover image dims with the card instead of separately)
   and highlights the border and the trailing "out" icon in primary
   (branded video/story cards hover to their own brand color instead, see
   below). flex-nowrap + min-w-0 let every card truncate instead of
   overflowing. */
.story-body :deep(.link-card) {
  @apply my-1 inline-flex min-w-0 max-w-full flex-nowrap items-center gap-2 rounded-sm border border-dashed border-slate-300 bg-slate-50/60 px-2.5 py-1 align-middle text-sm leading-5 shadow-none transition-all duration-300 dark:border-slate-600 dark:bg-slate-800/40;
}

.story-body :deep(.link-card:not(.story-card-dead):hover),
.story-body :deep(.link-card:not(.story-card-dead):focus-visible) {
  @apply brightness-90;
}

.story-body :deep(.link-card:not(.story-card-dead, .video-card, .story-card):hover),
.story-body :deep(.link-card:not(.story-card-dead, .video-card, .story-card):focus-visible) {
  @apply border-primary;
}

.story-body :deep(.link-card:not(.story-card-dead):hover) .link-card-open,
.story-body :deep(.link-card:not(.story-card-dead):focus-visible) .link-card-open {
  @apply text-primary;
}

.story-body :deep(.link-card-open) {
  @apply shrink-0 text-slate-400 transition-colors duration-300 dark:text-slate-500;
}

.story-body :deep(.link-card-label) {
  @apply min-w-0 truncate;
}

/* File card: the roomier variant — larger padding, a leading file icon and
   a two-line name/size column. */
.story-body :deep(.file-card) {
  @apply gap-3 p-3;
}

.story-body :deep(.file-card-icon) {
  @apply shrink-0 text-3xl text-slate-400 dark:text-slate-500;
}

.story-body :deep(.file-card-content) {
  @apply flex min-w-0 flex-1 flex-col;
}

.story-body :deep(.file-card-name) {
  @apply truncate font-mono font-semibold text-slate-800 dark:text-slate-100;
}

.story-body :deep(.file-card-size) {
  @apply text-xs text-slate-500 dark:text-slate-400;
}

/* Video card and story reference card: vertical blocks like Bilibili's own
   feed card (and our carousel item) — a brand strip on top (pink 哔哩哔哩 /
   primary 蠢猪档案), then an optional full-width cover, then the title and
   a muted secondary line. The video card's cover carries play/like stats
   bottom-left and duration bottom-right; the story card sets its rating
   badge at the card's bottom right corner instead. Pending/failed fetches
   and dead references render a muted placeholder cover with an icon. */
.story-body :deep(.video-card),
.story-body :deep(.story-card) {
  @apply my-3 w-64 max-w-full flex-col items-stretch gap-0 p-0;
}

/* The brand color lives once, on the card: the brand strip reads it, and on
   hover the neutral border switches to it (the whole-card brightness hover
   supplies the darkening, so no separate hover shade). The story card
   tracks the theme's primary color (subdued to the 700 shade in dark mode;
   .dark sits on <html>, an ancestor of this component, so the override
   needs :global). */
.story-body :deep(.video-card) {
  --card-brand: #fb7299;
}

.story-body :deep(.story-card) {
  @apply relative;
  --card-brand: theme('colors.primary');
}

.dark .story-body :deep(.story-card) {
  --card-brand: theme('colors.primary-600');
}

/* On hover the border reveals the card's brand color; dead story cards are
   not links and stay static. */
.story-body :deep(.video-card:hover),
.story-body :deep(.video-card:focus-visible),
.story-body :deep(.story-card:not(.story-card-dead):hover),
.story-body :deep(.story-card:not(.story-card-dead):focus-visible) {
  border-color: var(--card-brand);
}

/* Each card opens with a brand strip carrying its top corner rounding and
   spilling 1px over the card's top/side edges so the dashed border folds
   behind it; covers do the same on the sides and keep their own
   overflow-hidden for the image. */
.story-body :deep(.video-card-brand),
.story-body :deep(.story-card-brand) {
  @apply -mx-px -mt-px flex w-[calc(100%_+_2px)] items-center gap-1.5 rounded-t-sm px-2 py-1 text-white;
  background-color: var(--card-brand);
}

.story-body :deep(.video-card-logo) {
  @apply h-3.5 w-auto;
}

.story-body :deep(.story-card-brand .iconify) {
  @apply h-3.5 w-3.5;
}

.story-body :deep(.video-card-brand-text),
.story-body :deep(.story-card-brand-text) {
  @apply text-xs font-medium leading-4;
}

.story-body :deep(.video-card-out),
.story-body :deep(.story-card-out) {
  @apply ml-auto h-3.5 w-3.5 shrink-0 text-white/70;
}

.story-body :deep(.video-card-cover),
.story-body :deep(.story-card-cover) {
  @apply relative -mx-px w-[calc(100%_+_2px)] shrink-0 overflow-hidden bg-slate-200 dark:bg-slate-700;
}

/* Reset the global story-body img rules (max-h cap, min-w floor, zoom
   cursor); the cover keeps its natural aspect ratio at full card width
   instead of being cropped to a fixed frame. */
.story-body :deep(.video-card-cover img),
.story-body :deep(.story-card-cover img) {
  @apply m-0 block h-auto max-h-none w-full min-w-0 cursor-pointer rounded-none;
}

/* The empty placeholder has no image to size it, so it keeps a 16:9 box. */
.story-body :deep(.video-card-cover-empty),
.story-body :deep(.story-card-cover-empty) {
  @apply flex aspect-video items-center justify-center text-3xl text-slate-400 dark:text-slate-500;
}

.story-body :deep(.video-card-stats),
.story-body :deep(.video-card-duration) {
  @apply absolute bottom-0 flex items-center gap-1 bg-slate-950/70 px-1.5 py-0.5 text-[10px] leading-4 text-white;
}

/* gap between stat groups; icon-to-number gap lives on .video-card-stat. */
.story-body :deep(.video-card-stats) {
  @apply left-0 gap-2 rounded-tr-lg;
}

.story-body :deep(.video-card-stat) {
  @apply flex items-center gap-0.5;
}

.story-body :deep(.video-card-duration) {
  @apply right-0 rounded-tl-lg;
}

/* Rating badge: a large, translucent tier SVG on its own row at the
   content's bottom right (self-end in the flex column), so the text keeps
   the full card width. The global story-body img rules (min-w floor, zoom
   cursor, rounding) are reset on the img. */
.story-body :deep(.story-card-rating) {
  @apply m-0 mt-1 h-6 w-auto min-w-0 max-w-none cursor-pointer self-end rounded-none opacity-30;
}

.story-body :deep(.video-card-content),
.story-body :deep(.story-card-content) {
  @apply flex min-w-0 flex-1 flex-col gap-0.5 px-2.5 pb-2 pt-1;
}

/* Center the story card's rows as boxes (same idiom as MyContent/StoryCard);
   once a row wraps, its lines lean left inside the shrink-wrapped box. */
.story-body :deep(.story-card-content) {
  @apply items-center;
}

/* Same wrap rule as StoryCard/StoryHeader: override the body's inherited
   overflow-wrap:anywhere with the gentler break-word, and min-w-0 lets the
   flex item shrink below a long unbroken word so break-word can split it. */
.story-body :deep(.story-card-title),
.story-body :deep(.story-card-desc) {
  @apply min-w-0 break-words;
}

.story-body :deep(.video-card-title),
.story-body :deep(.story-card-title) {
  @apply my-0.5 font-semibold text-slate-800 dark:text-slate-100;
}

/* Only the video card still centers its text lines. */
.story-body :deep(.video-card-title) {
  @apply text-center;
}

.story-body :deep(.video-card-uploader),
.story-body :deep(.story-card-desc) {
  @apply mt-1 text-xs text-slate-500 dark:text-slate-400;
}

.story-body :deep(.video-card-uploader) {
  @apply flex items-center gap-1;
}

.story-body :deep(.video-card-up) {
  @apply shrink-0 rounded-full border border-slate-300 px-[.2rem] text-[10px] leading-3 text-slate-400 dark:border-slate-600 dark:text-slate-500;
}

/* Dead fetches/references mute the placeholder title. */
.story-body :deep(.video-card-dead .video-card-title),
.story-body :deep(.story-card-dead .story-card-title) {
  @apply font-normal text-slate-400 dark:text-slate-500;
}

/* Tall images whose width would collapse under the max-h-64 cap are forced
   back up to min-w-48, and wide images whose height would collapse under
   max-w-full are forced back up to min-h-48; object-cover keeps the aspect
   ratio and object-top crops the resulting overflow at the bottom (tall) or
   both sides (wide). The min floors must stay fixed lengths: percentages are
   unresolvable in max-content contexts (carousel items, table cells), where
   they would silently disable the mechanism. Built-in card images (video /
   story covers, rating badges) carry .built-in-img and opt out — e.g. the
   rating badge's h-6 would otherwise lose to the min-h floor. */
.story-body :deep(img:not(.built-in-img)) {
  @apply max-w-full max-h-64 min-w-32 min-h-32 cursor-zoom-in rounded-sm object-cover object-top transition-[filter] duration-300;
}

.story-body :deep(.img-frame) {
  @apply relative inline-block w-fit;
}

.story-body :deep(.img-frame > img) {
  @apply block;
}

/* Bottom-anchored gradient cover, shown only when JS confirms the image is
   actually clipped (data-cropped). Clicks fall through to the image. The
   long fade (pt-16) keeps the hint text on a solid enough background. */
.story-body :deep(.long-img-cover) {
  @apply pointer-events-none absolute inset-x-0 bottom-0 hidden items-end justify-center rounded-b-sm bg-gradient-to-t from-slate-950/90 via-slate-900/50 to-transparent px-2 pb-2 pt-16 text-center text-xs font-medium text-white;
}

.story-body :deep(.img-frame[data-cropped] .long-img-cover) {
  @apply flex;
}

.story-body :deep(img:not(.built-in-img):hover) {
  @apply brightness-90;
}

/* Card covers must not take the img hover dimming: the whole card already
   darkens on hover, a second dimming would double-darken the cover. */
.story-body :deep(.video-card-cover img:hover),
.story-body :deep(.story-card-cover img:hover),
.story-body :deep(.story-card-rating:hover) {
  @apply brightness-100;
}

.story-body :deep(.carousel-shell) {
  @apply relative my-4;
  /* Single source for the edge-fade width; nav jumps read it in JS too. */
  --carousel-fade-width: 3rem;
}

/* Edge fades: while the strip can scroll in a direction, mask its content
   near that edge so the nav button floats over clear space and stays
   distinguishable. The fade widths are registered custom properties so they
   transition smoothly with the buttons; without @property support the mask
   simply toggles. */
@property --carousel-fade-l {
  syntax: '<length>';
  inherits: false;
  initial-value: 0px;
}

@property --carousel-fade-r {
  syntax: '<length>';
  inherits: false;
  initial-value: 0px;
}

.story-body :deep(.image-carousel) {
  @apply m-0 flex items-end gap-3 overflow-x-auto overflow-y-clip pb-2;
  /* Multi-stop ramp: the opacity eases in over the fade width instead of
     jumping along a single straight slope, so the fade reads smoother. */
  mask-image: linear-gradient(
    to right,
    transparent 0,
    rgb(0 0 0 / 0.3) calc(var(--carousel-fade-l, 0px) * 0.4),
    rgb(0 0 0 / 0.75) calc(var(--carousel-fade-l, 0px) * 0.75),
    #000 var(--carousel-fade-l, 0px),
    #000 calc(100% - var(--carousel-fade-r, 0px)),
    rgb(0 0 0 / 0.75) calc(100% - var(--carousel-fade-r, 0px) * 0.75),
    rgb(0 0 0 / 0.3) calc(100% - var(--carousel-fade-r, 0px) * 0.4),
    transparent 100%
  );
  transition: --carousel-fade-l 0.3s ease, --carousel-fade-r 0.3s ease;
}

.story-body :deep(.carousel-shell:has(.carousel-prev[data-on='true']) .image-carousel) {
  --carousel-fade-l: var(--carousel-fade-width);
}

.story-body :deep(.carousel-shell:has(.carousel-next[data-on='true']) .image-carousel) {
  --carousel-fade-r: var(--carousel-fade-width);
}

.story-body :deep(.carousel-nav) {
  @apply absolute top-[50%] z-10 flex h-9 w-9 -translate-y-1/2 cursor-pointer items-center justify-center rounded-full border border-white/25 bg-slate-900/70 text-xl text-white shadow-lg shadow-black/20 hover:bg-slate-900/90 dark:border-slate-900/20 dark:bg-white/75 dark:text-slate-900 dark:hover:bg-white/90 backdrop-blur-sm transition-all;
}

.story-body :deep(.carousel-nav[data-on='false']) {
  @apply opacity-0 pointer-events-none;
}

/* The hint label stays hidden unless the next button is both active and
   still pre-first-scroll (data-hint); then the button widens into a pill. */
.story-body :deep(.carousel-hint-text) {
  @apply hidden whitespace-nowrap;
}

.story-body :deep(.carousel-next[data-on='true'][data-hint='true']) {
  @apply w-auto gap-1 px-2.5;
}

.story-body :deep(.carousel-next[data-on='true'][data-hint='true']) .carousel-hint-text {
  @apply inline text-sm font-bold;
}

.story-body :deep(.carousel-prev) {
  @apply -left-2;
}

.story-body :deep(.carousel-next) {
  @apply -right-2;
}

/* max-w-full caps the item at the strip's width: with shrink-0 the item
   would otherwise size to the image's max-content width, so the whole
   fit-content chain (item > .img-frame > img) never clamps and the img's
   own max-w-full resolves against that oversized box — overflowing the
   strip into a scroller even for a single image. */
.story-body :deep(.carousel-item) {
  @apply flex max-w-full shrink-0 flex-col;
}

.story-body :deep(.carousel-caption) {
  @apply w-0 min-w-full whitespace-normal break-words font-medium text-xs rounded-b-sm bg-slate-200/80 px-2.5 py-1 text-slate-600 dark:bg-slate-800/80 dark:text-slate-300;
}

.story-body :deep(.carousel-caption p) {
  @apply my-1;
}

/* With a caption the image's bottom corners turn square so the caption bar
   contacts it cleanly (the caption carries the bottom rounding). */
.story-body :deep(.carousel-item-captioned img) {
  @apply rounded-b-none;
}

.story-body :deep(.image-carousel img) {
  @apply m-0;
}

.story-body :deep(ul),
.story-body :deep(ol) {
  @apply my-3 list-outside space-y-1 pl-6;
}

.story-body :deep(ul) {
  @apply list-disc;
}

.story-body :deep(ol) {
  @apply list-decimal;
}

/* Deeper levels get distinct markers so nesting stays readable. */
.story-body :deep(li > ul) {
  @apply list-[circle];
}

.story-body :deep(li > ol) {
  @apply list-[lower-alpha];
}

.story-body :deep(li > ul > li > ul) {
  @apply list-[square];
}

.story-body :deep(li > ol > li > ol) {
  @apply list-[lower-roman];
}

.story-body :deep(blockquote) {
  @apply my-3 border-l-4 border-slate-200 pl-3 text-slate-500 dark:border-slate-700 dark:text-slate-400;
}

.story-body :deep(> blockquote),
.story-body :deep(section > blockquote) {
  @apply my-6;
}

.story-body :deep(.markdown-alert) {
  @apply my-4 rounded-sm border border-l-4 px-4 py-3 text-slate-700 dark:text-slate-300;
}

.story-body :deep(.markdown-alert-title) {
  @apply mb-2 mt-0 flex items-center gap-1.5 text-base font-bold tracking-normal;
}

.story-body :deep(.markdown-alert-title .iconify) {
  @apply text-base;
}

.story-body :deep(.markdown-alert-note) {
  @apply border-sky-300 bg-sky-50 dark:border-sky-700 dark:bg-sky-950/30;
}

.story-body :deep(.markdown-alert-note .markdown-alert-title) {
  @apply text-sky-700 dark:text-sky-400;
}

.story-body :deep(.markdown-alert-tip) {
  @apply border-primary-300 bg-primary-50 dark:border-primary-700 dark:bg-primary-950/30;
}

.story-body :deep(.markdown-alert-tip .markdown-alert-title) {
  @apply text-primary-700 dark:text-primary-400;
}

.story-body :deep(.markdown-alert-important) {
  @apply border-indigo-300 bg-indigo-50 dark:border-indigo-700 dark:bg-indigo-950/30;
}

.story-body :deep(.markdown-alert-important .markdown-alert-title) {
  @apply text-indigo-700 dark:text-indigo-400;
}

.story-body :deep(.markdown-alert-warning) {
  @apply border-amber-300 bg-amber-50 dark:border-amber-700 dark:bg-amber-950/30;
}

.story-body :deep(.markdown-alert-warning .markdown-alert-title) {
  @apply text-amber-700 dark:text-amber-400;
}

.story-body :deep(.markdown-alert-caution) {
  @apply border-red-300 bg-red-50 dark:border-red-700 dark:bg-red-950/30;
}

.story-body :deep(.markdown-alert-caution .markdown-alert-title) {
  @apply text-red-700 dark:text-red-400;
}

/* The body's overflow-wrap:anywhere would split the bordered chip mid-token,
   and even normal wrapping breaks at spaces inside it (`N = 3`); nowrap +
   normal overflow-wrap keep the chip whole, moving it to the next line as
   one piece (a chip longer than a full line overflows instead of wrapping). */
.story-body :deep(code) {
  @apply whitespace-nowrap rounded-sm border border-slate-300 dark:border-slate-600 bg-slate-100 px-[0.3em] py-[0.1em] font-mono text-[1em] [overflow-wrap:normal] dark:bg-slate-800;
}

.story-body :deep(.chip-code-gap-l) {
  @apply ml-1;
}

.story-body :deep(.chip-code-gap-r) {
  @apply mr-1;
}

.story-body :deep(.chip-card-gap-l) {
  @apply ml-1;
}

.story-body :deep(.chip-card-gap-r) {
  @apply mr-1;
}

.story-body :deep(pre) {
  @apply my-3 overflow-hidden border border-l-4 rounded-sm leading-5 border-slate-300 dark:border-slate-600 bg-slate-100 dark:bg-slate-800;
}

.story-body :deep(pre > .code-scroll) {
  @apply overflow-x-auto p-3;
}

.story-body :deep(pre code) {
  @apply bg-transparent border-none m-0 p-0;
}

.story-body :deep(hr) {
  @apply my-6 border-slate-200 dark:border-slate-700;
}

/** Stupid Kimi, can't even resolve the table-border issue. I ran out
    of my 300 mins quota, and it turns out Kimi wants to work me out. */
.story-body :deep(table) {
  @apply my-3 overflow-hidden text-xs rounded-sm border border-slate-200 dark:border-slate-700;
  outline: 1px solid theme('colors.slate.200');
  outline-offset: -1px;
  @apply dark:outline-slate-700;
}

.story-body :deep(> table),
.story-body :deep(section > table) {
  @apply my-6;
}

.story-body :deep(caption) {
  @apply mb-1.5 text-center text-slate-500 dark:text-slate-400;
}

.story-body :deep(thead) {
  @apply bg-slate-50 dark:bg-slate-800/50;
}

.story-body :deep(th) {
  @apply font-bold text-slate-700 dark:text-slate-200;
}

.story-body :deep(th),
.story-body :deep(td) {
  @apply border border-slate-200 dark:border-slate-700 px-2.5 py-1.5 text-left;
}
</style>
