<template>
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
import type { ContentStoryAttachment, ContentStorySummary } from '@shared/types/content'
import { strip_front_matter } from '@shared/content-markdown'
import { story_rating } from '@shared/types/content'
import MarkdownIt from 'markdown-it'
import { file_icon, file_icon_names } from '~/utils/content/attachment'
import { html_no_markdown_tags } from '~/utils/content/html'

type AlertType = 'NOTE' | 'TIP' | 'IMPORTANT' | 'WARNING' | 'CAUTION'

interface RenderEnvironment {
  images: string[]
}

interface FileCardData {
  icon: string
  size: string
  /** Set when the link has no label; the card then renders the file name itself. */
  name: string | null
}

interface StoryCardMeta {
  /** Rating tier text ('夯') when the referenced story exists. */
  tier: string | null
  title: string
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

const compiled_icons = [
  ... file_icon_names.map(icon => `lucide:${icon}`),
  ... Object.values(alert_icons).map(icon => `lucide:${icon}`),
  'lucide:external-link',
  'lucide:circle-alert',
  'lucide:chevron-left',
  'lucide:chevron-right',
]

const static_url = useStaticUrl()
const body_markdown = computed(() => strip_front_matter(props.markdown))
const preview_visible = ref(false)
const preview_index = ref(0)

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
    return static_url(`/content/${props.storyId ?? 0}/${url}`)
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
  const icon = alert_icons[alert_type]
  const alert_title = tokens[idx]?.meta?.alert_title as string | null | undefined
  const title = alert_title ? md.utils.escapeHtml(alert_title) : alert_labels[alert_type]
  return `<blockquote class="markdown-alert markdown-alert-${alert_type.toLowerCase()}"><p class="markdown-alert-title"><span class="iconify i-lucide:${icon}" aria-hidden="true"></span><span>${title}</span></p>\n`
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
  if (! token?.meta?.carousel) {
    return rendered_image
  }
  // Carousel images carry their alt text as a visible caption below the
  // image. The wrapper must be a span, not <figure>: the carousel is a
  // <p>, and a figure would force the browser to close it early. An empty
  // alt (the insertion default) or one repeating the file name is not a
  // real caption — skip it.
  const caption = token.content && token.content !== (src ? local_file_name(src) : null)
    ? `<span class="carousel-caption">${md.utils.escapeHtml(token.content)}</span>`
    : ''
  const captioned = caption ? ' carousel-item-captioned' : ''
  return `<span class="carousel-item${captioned}">${rendered_image}${caption}</span>`
}

const default_link_rule = md.renderer.rules.link_open
  ?? ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options))
md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  const token = tokens[idx]
  let href = token?.attrGet('href')
  if (href) {
    const has_text_label = tokens[idx + 1]?.type === 'text' && tokens[idx + 2]?.type === 'link_close'
    const close_index = has_text_label ? idx + 2 : (tokens[idx + 1]?.type === 'link_close' ? idx + 1 : - 1)

    // `[](@title)` (label-off) renders as a compact story card; a labeled
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
        if (story) {
          token!.attrSet('href', `/content/${story.id}`)
          token!.attrSet('target', '_blank')
          token!.attrSet('rel', 'noopener noreferrer')
          token!.attrJoin('class', 'link-card story-card')
          const tier = story_rating(story.labels)
          token!.meta = { ... token?.meta, story_card: { tier, title: story.title, dead: false } satisfies StoryCardMeta }
          const rendered_link = default_link_rule(tokens, idx, options, env, self)
          return `${rendered_link}<span class="story-card-rating rating-${tier}">${tier}</span><span class="story-card-title">${md.utils.escapeHtml(story.title)}</span>`
        }
        // Dead reference: the target story is gone; render a muted placeholder.
        token!.meta = { ... token?.meta, story_card: { tier: null, title: story_title, dead: true } satisfies StoryCardMeta }
        return `<span class="link-card story-card story-card-dead"><span class="story-card-title">${md.utils.escapeHtml(story_title)}</span>`
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
    const icon = story_card.dead ? 'circle-alert' : 'external-link'
    const closing = story_card.dead ? '</span>' : default_link_close_rule(tokens, idx, options, env, self)
    return `<span class="link-card-open iconify i-lucide:${icon}" aria-hidden="true"></span>${closing}`
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
    return `</div><button type="button" class="carousel-nav carousel-next" aria-label="下一张"><span class="carousel-hint-text" aria-hidden="true">右边还有</span><span class="iconify i-lucide:chevron-right" aria-hidden="true"></span></button></div>\n`
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
  return `<pre><div class="code-scroll"><code${lang_class}>${md.utils.escapeHtml(token.content)}</code></div></pre>\n`
}

md.renderer.rules.code_block = (tokens, idx) =>
  `<pre><div class="code-scroll"><code>${md.utils.escapeHtml(tokens[idx]!.content)}</code></div></pre>\n`

// HTML wrappers that are allowed to contain markdown: every element except
// raw-text/code/embedded ones. Mirror of the editor's nested-language list.

// A wrapper whose content is entirely markdown (no blank lines, or the block
// parser would have split it): `<tag ...>...</tag>` in one html_block token.
const html_wrapper_pattern = /^<([a-z][\w-]*)\b([^>]*)>([\s\S]*?)<\/\1>\s*$/i

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
  const wrapper = html_wrapper_pattern.exec(token.content)
  if (wrapper && ! html_no_markdown_tags.has(wrapper[1]!.toLowerCase())) {
    const tag = wrapper[1]!
    const attrs = wrapper[2]!
    const inner = wrapper[3]!
    // Reuse the same env so nested markdown (images, cards) feeds the
    // preview lightbox through the shared images array.
    const inner_html = md.render(dedent_html_inner(inner), env)
    return `<${tag}${attrs}>${inner_html}</${tag}>\n`
  }
  return default_html_block_rule(tokens, idx, options, env, self)
}

const render_result = computed(() => {
  const environment: RenderEnvironment = { images: [] }
  return {
    html: md.render(body_markdown.value, environment),
    images: environment.images,
  }
})

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

// Set up every carousel once the rendered HTML is in the DOM, and whenever
// it re-renders.
watch(render_result, () => {
  nextTick(refresh_carousel_navs)
}, { flush: 'post' })

onMounted(() => {
  nextTick(refresh_carousel_navs)
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

.story-body :deep(h1, h2, h3, h4, h5, h6) {
  @apply my-8 font-bold text-slate-800 dark:text-slate-100;
}

.story-body :deep(p) {
  @apply my-2;
}

.story-body :deep(> p) {
  @apply my-6;
}

/* Abstract card chrome shared by plain links, file cards and story cards:
   dashed border, tinted background, small line height so the card embeds
   into the text line, and a hover state that highlights the border and the
   trailing "out" icon in primary. flex-nowrap + min-w-0 let every card
   truncate instead of overflowing. */
.story-body :deep(.link-card) {
  @apply my-1 inline-flex min-w-0 max-w-full flex-nowrap items-center gap-2 rounded-sm border border-dashed border-slate-300 bg-slate-50/60 px-2.5 py-1 align-middle text-sm leading-5 shadow-none transition-colors dark:border-slate-600 dark:bg-slate-800/40;
}

.story-body :deep(.link-card:not(.story-card-dead):hover),
.story-body :deep(.link-card:not(.story-card-dead):focus-visible) {
  @apply border-primary;
}

.story-body :deep(.link-card:not(.story-card-dead):hover) .link-card-open,
.story-body :deep(.link-card:not(.story-card-dead):focus-visible) .link-card-open {
  @apply text-primary;
}

.story-body :deep(.link-card-open) {
  @apply shrink-0 text-slate-400 transition-colors dark:text-slate-500;
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

/* Story card: compact variant. Dead references (target story gone) render
   muted and skip the interactive hover state. */
.story-body :deep(.story-card-dead) {
  @apply text-slate-400 dark:text-slate-500;
}

.story-body :deep(.story-card-rating) {
  @apply inline-flex shrink-0 items-center rounded-tl-full rounded-br-full px-2.5 py-0.5 text-xs font-bold text-white;
}

.story-body :deep(.story-card-title) {
  @apply min-w-0 truncate;
}

.story-body :deep(img) {
  @apply max-w-full max-h-72 cursor-zoom-in rounded-sm transition-[filter] duration-300;
}

.story-body :deep(img:hover) {
  @apply brightness-90;
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
  @apply m-0 flex items-center gap-3 overflow-x-auto overflow-y-clip pb-2;
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
  @apply inline text-sm;
}

.story-body :deep(.carousel-prev) {
  @apply -left-2;
}

.story-body :deep(.carousel-next) {
  @apply -right-2;
}

.story-body :deep(.carousel-item) {
  @apply flex w-max min-w-0 max-w-[100%-10rem] shrink-0 flex-col;
}

.story-body :deep(.carousel-caption) {
  @apply w-0 min-w-full whitespace-normal break-words rounded-b-sm bg-slate-200/80 px-2 py-1 text-xs text-slate-600 dark:bg-slate-800/80 dark:text-slate-300;
}

/* With a caption the image's bottom corners turn square so the caption bar
   contacts it cleanly (the caption carries the bottom rounding). */
.story-body :deep(.carousel-item-captioned img) {
  @apply rounded-b-none;
}

.story-body :deep(.image-carousel img) {
  @apply m-0 max-w-full;
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

.story-body :deep(blockquote) {
  @apply my-3 border-l-4 border-slate-200 pl-3 text-slate-500 dark:border-slate-700 dark:text-slate-400;
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
  @apply border-emerald-300 bg-emerald-50 dark:border-emerald-700 dark:bg-emerald-950/30;
}

.story-body :deep(.markdown-alert-tip .markdown-alert-title) {
  @apply text-emerald-700 dark:text-emerald-400;
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

.story-body :deep(code) {
  @apply rounded-sm border border-slate-300 dark:border-slate-600 bg-slate-100 px-1.5 py-1 font-mono text-xs dark:bg-slate-800;
}

.story-body :deep(.chip-code-gap-l) {
  @apply ml-0.5;
}

.story-body :deep(.chip-code-gap-r) {
  @apply mr-0.5;
}

.story-body :deep(.chip-card-gap-l) {
  @apply ml-1;
}

.story-body :deep(.chip-card-gap-r) {
  @apply mr-1;
}

.story-body :deep(.chip-code-gap-r + .chip-code-gap-l) {
  @apply ml-0;
}

.story-body :deep(.chip-card-gap-r + .chip-card-gap-l) {
  @apply ml-0;
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

.story-body :deep(table) {
  @apply my-3 w-full border-collapse text-xs;
}

.story-body :deep(th),
.story-body :deep(td) {
  @apply border border-slate-200 px-2 py-1 dark:border-slate-700;
}
</style>
