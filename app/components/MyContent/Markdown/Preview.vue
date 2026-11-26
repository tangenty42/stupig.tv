<template>
  <!-- Invisible <MyIcon> instances that pull every v-html-only icon into the
       bundle; see compiled_icons below. -->
  <div class="hidden" aria-hidden="true">
    <MyIcon v-for="icon in compiled_icons" :key="icon" :name="icon" />
  </div>

  <MyContentMarkdownBody
    v-if="body_markdown.trim()"
    ref="body_component"
    :html="render_result.html"
    @click="on_preview_click"
    @auxclick="on_preview_auxclick"
    @keydown="on_preview_keydown"
  />
  <p v-else-if="emptyText" class="py-10 text-center text-sm text-slate-400 dark:text-slate-500">
    {{ emptyText }}
  </p>

  <ClientOnly>
    <MyImagePreview
      v-if="render_result.images.length"
      v-model:visible="preview_visible"
      :images="preview_images"
      :initial-index="preview_index"
    />
  </ClientOnly>
</template>

<script setup lang="ts">
import type { ContentStoryAttachment, ContentStorySummary } from '@shared/types/content'
import { settings } from '@shared/settings'
import { useAttachmentDownload } from '~/features/content/attachments/download'
import { private_attachment_open_denied_message } from '~/features/content/attachments/presentation'
import { attachment_is_media, attachment_is_restricted } from '~/features/content/attachments/rules'
import { save_url_as } from '~/features/content/browser-navigation'
import { useStoryPreview } from '~/features/content/markdown/preview'
import { attachment_for_link } from '~/features/content/markdown/preview/attachment-links'
import { story_compiled_icons } from '~/features/content/markdown/render/compiled-icons'

const props = withDefaults(defineProps<{
  markdown: string
  storyId?: number | null
  attachments?: ContentStoryAttachment[]
  folders?: string[]
  canReadPrivate?: boolean
  emptyText?: string
  /** Known stories so `[](@title)` references render as story cards. */
  stories?: ContentStorySummary[]
  /**
   * Set by a host that can act on a folder card (reveal the folder in its
   * attachment list). Left off, the card renders inert.
   */
  folderOpenable?: boolean
  /** Simulate a reader without secret access while retaining the author's editing data. */
  publicView?: boolean
}>(), {
  storyId: null,
  attachments: () => [],
  folders: () => [],
  canReadPrivate: false,
  emptyText: '',
  stories: () => [],
  folderOpenable: false,
  publicView: false,
})

const emit = defineEmits<{
  /** A folder card was activated; the host decides where the folder opens. */
  'folder-open': [folder: string]
}>()

// Every icon the rendered v-html can contain must be pre-registered (see
// story_compiled_icons); the hidden div above forces them into the bundle,
// an icon missing from the list renders blank in the preview.
const compiled_icons = story_compiled_icons

const static_url = useStaticUrl()
const attachment_download = useAttachmentDownload()
const { error: toast_error, info: toast_info } = useMyToast()
const preview_visible = ref(false)
const preview_index = ref(0)
const preview_images = ref<string[]>([])

const { body_markdown, render_result, preview_attachments } = useStoryPreview(() => props.markdown, {
  story_id: () => props.storyId,
  attachments: () => props.attachments,
  folders: () => props.folders,
  can_read_private: () => props.canReadPrivate,
  stories: () => props.stories,
  static_url,
  lqip_max_bytes: settings.app.content.image.lqipMaxBytes,
  folder_card_openable: () => props.folderOpenable,
  public_view: () => props.publicView,
})

/** The folder a click/keypress targets, or null when it is not a folder card. */
function folder_from_event(event: Event) {
  if (! (event.target instanceof HTMLElement)) {
    return null
  }
  return event.target.closest<HTMLElement>('[data-folder-card]')?.dataset.folderCard ?? null
}

const body_component = useTemplateRef<{ el: HTMLElement | null }>('body_component')
const story_body = computed(() => body_component.value?.el ?? null)

/** All readable attachments use the same authenticated resolver. */
const plain_attachments_by_url = computed(() => new Map(preview_attachments.value.filter(file => file.url).map(file => [static_url(file.url), file])))
const denied_attachments_by_url = computed(() => new Map(
  props.publicView || ! props.canReadPrivate
    ? props.attachments.filter(file => file.url && attachment_is_restricted(file)).map(file => [static_url(file.url), file])
    : [],
))
watch([() => props.publicView, () => props.canReadPrivate], () => {
  preview_visible.value = false
  preview_images.value = []
  preview_index.value = 0
})

/** Saves an attachment under its row name instead of opening the nameless object URL. */
async function download_plain(attachment: ContentStoryAttachment) {
  const story_id = props.storyId
  if (! story_id)
    return
  try {
    save_url_as(await attachment_download.sign(story_id, attachment.file_name))
  }
  catch {
    toast_error('附件下载失败')
  }
}

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
  preview_images.value = [... render_result.value.images]
  story_body.value?.querySelectorAll<HTMLImageElement>('img[data-preview-index]').forEach((item) => {
    const item_index = Number(item.dataset.previewIndex)
    if (Number.isInteger(item_index) && item_index >= 0 && item_index < preview_images.value.length) {
      preview_images.value[item_index] = item.src
    }
  })
  preview_visible.value = true
}

function on_preview_click(event: MouseEvent) {
  const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a[href]') : null
  if (block_denied_attachment_link(event, link))
    return
  const image = preview_image_from_event(event)
  if (image) {
    open_image_preview(image)
    return
  }
  // A plain attachment link saves under its row name; media stay viewable and
  // keep their native tab navigation.
  const attachment = link ? attachment_for_link(plain_attachments_by_url.value, link) : undefined
  if (attachment && ! attachment_is_media(attachment)) {
    event.preventDefault()
    void download_plain(attachment)
    return
  }
  const folder = folder_from_event(event)
  if (folder) {
    activate_folder(folder)
  }
}

function on_preview_auxclick(event: MouseEvent) {
  if (event.button === 1 && event.target instanceof Element)
    block_denied_attachment_link(event, event.target.closest<HTMLAnchorElement>('a[href]'))
}

function block_denied_attachment_link(event: MouseEvent, link: HTMLAnchorElement | null) {
  if (! link)
    return false
  const denied = denied_attachments_by_url.value
  const same_origin = link.origin === link.ownerDocument.location?.origin
  if (! attachment_for_link(denied, link) && ! (same_origin && denied.has(link.pathname + link.search)))
    return false
  event.preventDefault()
  toast_info(private_attachment_open_denied_message)
  return true
}

function activate_folder(folder: string) {
  if (props.folderOpenable) {
    emit('folder-open', folder)
  }
  else {
    toast_info('预览中无法打开附件列表~')
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
    return
  }
  const folder = folder_from_event(event)
  if (folder) {
    event.preventDefault()
    activate_folder(folder)
  }
}
</script>

<style scoped>
.story-body {
  @apply leading-7 text-slate-700 [overflow-wrap:anywhere] dark:text-slate-300;
  word-spacing: 0.25em;
}

/* Headings pin below the fixed app header while their section scrolls under
   them. JS nests sections by heading level and measures stacked offsets, so a
   subsection title docks below its pinned chapter title and only a
   same-or-higher-level heading pushes it away. Higher levels paint above
   lower ones, so an exiting heading passes under its pinned ancestor's
   background instead of veiling it. The backgrounds are opaque so an
   exiting lower-level title cannot show through a higher-level title. The
   padding sits inside the background, doubling as vertical spacing. */
.story-body :deep(h1),
.story-body :deep(h2),
.story-body :deep(h3),
.story-body :deep(h4),
.story-body :deep(h5),
.story-body :deep(h6) {
  @apply sticky mb-2 bg-white py-2 font-bold text-slate-800 dark:bg-slate-900 dark:text-slate-100;
  top: var(--app-header-height, 0px);
  /* Full-bleed: the bar spans the viewport while the compensating
     padding keeps the title text aligned with the content column. */
  margin-inline: calc(50% - var(--app-half-viewport, 50vw));
  padding-inline: calc(var(--app-half-viewport, 50vw) - 50%);
}

/* compensate_section_push() measures flow positions with pinning suspended. */
.story-body.measuring :deep(h1),
.story-body.measuring :deep(h2),
.story-body.measuring :deep(h3),
.story-body.measuring :deep(h4),
.story-body.measuring :deep(h5),
.story-body.measuring :deep(h6) {
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
.story-body :deep(h1)::before,
.story-body :deep(h2)::before,
.story-body :deep(h3)::before,
.story-body :deep(h4)::before,
.story-body :deep(h5)::before,
.story-body :deep(h6)::before {
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
   opaque surface and small line height. flex-nowrap + min-w-0 let each
   card truncate instead of overflowing. */
.story-body :deep(.link-card) {
  @apply my-1 inline-flex min-w-0 max-w-full flex-nowrap items-center gap-2 rounded-sm px-2.5 py-1 align-middle text-sm font-medium leading-5 no-underline transition-[filter] duration-300;
  --card-icon-color: var(--content-accent-neutral);
  --card-accent: var(--card-icon-color);
  background-color: var(--content-card-surface);
}

.story-body :deep(a.link-card[href]),
.story-body :deep(.link-card[data-folder-card]) {
  border-bottom: 4px solid var(--card-accent);
}

.story-body :deep(a.link-card[href]:hover),
.story-body :deep(a.link-card[href]:focus-visible),
.story-body :deep(.link-card[data-folder-card]:hover),
.story-body :deep(.link-card[data-folder-card]:focus-visible),
.story-body :deep(img:not(.built-in-img):hover) {
  @apply brightness-90;
}

.dark .story-body :deep(a.link-card[href]:hover),
.dark .story-body :deep(a.link-card[href]:focus-visible),
.dark .story-body :deep(.link-card[data-folder-card]:hover),
.dark .story-body :deep(.link-card[data-folder-card]:focus-visible),
.dark .story-body :deep(img:not(.built-in-img):hover) {
  @apply brightness-125;
}

.story-body :deep(.link-card-open),
.story-body :deep(.link-card-icon),
.story-body :deep(.link-card-tag) {
  @apply shrink-0;
  color: var(--card-icon-color);
}

.story-body :deep(.folder-card[data-folder-card]) {
  @apply cursor-pointer;
}

/* Keep the outline in the line box so its border and padding reserve space.
   The label can wrap inside the chip when it is wider than the paragraph. */
.story-body :deep(.link-chip) {
  @apply inline-block break-words px-[0.625em] py-[0.125em] align-baseline text-[0.875em];
  line-height: normal;
  overflow-wrap: anywhere;
}

.story-body :deep(.link-chip) .link-card-icon {
  @apply mr-[0.25em];
}

.story-body :deep(.link-chip) .link-card-tag {
  @apply mr-[0.4em];
}

.story-body :deep(.link-chip) .link-card-label {
  @apply whitespace-normal;
}

.story-body :deep(.link-chip code) {
  @apply inline-block max-w-full;
}

.story-body :deep(.link-chip) .link-card-open {
  @apply ml-[0.4em];
}

.story-body :deep(.private-block),
.story-body :deep(.private-inline) {
  @apply rounded-sm;
  background-color: var(--content-card-surface);
}

.story-body :deep(.private-block) {
  @apply my-3;
}

.story-body :deep(.private-inline) {
  @apply my-1 inline-block max-w-full align-middle;
}

.story-body :deep(.private-content-body) {
  @apply block px-2 py-1;
}

.story-body :deep(.private-block > .private-content-body > :first-child) {
  margin-top: 0;
}

.story-body :deep(.private-block > .private-content-body > :last-child) {
  margin-bottom: 0;
}

/* Permission denials and render failures share the same solid card background.
   The inline, block and media variants reserve space for the replaced content. */
.story-body :deep(.content-placeholder) {
  @apply cursor-default rounded-sm text-slate-500 dark:text-slate-400;
  background-color: var(--content-card-surface);
}

/* Sized like a file card so a failed card keeps the card's footprint. */
.story-body :deep(.content-placeholder-inline) {
  @apply my-1 inline-flex min-h-14 min-w-48 max-w-full items-center gap-2 px-3 py-2 align-middle text-sm leading-5;
}

.story-body :deep(.content-placeholder-inline .iconify) {
  @apply h-5 w-5 shrink-0;
}

.story-body :deep(.content-placeholder-block) {
  @apply my-3 flex items-center gap-2 px-3 py-2 text-sm;
}

/* html_wrappers re-renders the placeholder's inner as a paragraph. */
.story-body :deep(.content-placeholder-block > p) {
  @apply m-0 flex items-center gap-2;
}

.story-body :deep(.content-placeholder-media) {
  @apply min-h-40 w-64 max-w-full flex-col items-center justify-center gap-2 px-6 py-10 text-sm;
}

/* Failed-image placeholders share the frame's visibility and fade. */
.story-body :deep(.content-placeholder-media:not(.image-unavailable)) {
  @apply flex;
}

.story-body :deep(.content-placeholder-media .iconify) {
  @apply text-3xl;
}

.story-body :deep(.carousel-item-captioned .content-placeholder-media) {
  @apply rounded-b-none;
}

.story-body :deep(.private-image-block) {
  @apply my-3 block;
}

/* The privacy label is shared by attachments and private Markdown. */
.story-body :deep(.attachment-privacy-brand) {
  @apply flex items-center gap-1.5 rounded-t-sm px-2 py-1 text-xs font-medium leading-4;
  color: var(--content-accent-private);
  background-color: var(--content-card-surface);
}

.story-body :deep(.attachment-privacy-brand-redacted) {
  color: var(--content-accent-redacted);
}

/* Inside the private image card the cap is full-width, so the shrink-wrapped
   frame (inline-block w-fit) must stretch too, or the card out-widens the
   image and the caption floats off to the side. */
.story-body :deep(.private-image-block-brand ~ .img-frame),
.story-body :deep(.private-image-block .img-frame) {
  @apply block w-full rounded-t-none;
}

.story-body :deep(.private-image-block .img-frame > img) {
  @apply w-full;
}

/* Only the top rounding drops (the cap is above). display:block because the
   caption's width idiom (w-0 + min-w-full) is ignored on inline boxes —
   normally it is a direct flex child of the carousel item. */
.story-body :deep(.private-image-block .carousel-caption) {
  @apply block rounded-t-none;
}

/* The global img rules set display, which beats the [hidden] UA style — and
   the generic img[hidden] rule loses to .img-frame > img on specificity. */
.story-body :deep(.img-frame > img[hidden]) {
  @apply hidden;
}

/* File card: the roomier variant — larger padding, a leading file icon and
   a two-line name/size column. */
.story-body :deep(.file-card) {
  @apply flex-col items-stretch gap-0 overflow-hidden p-0;
}

.story-body :deep(.file-card-body) {
  @apply flex min-w-0 items-center gap-3 p-3;
}

.story-body :deep(.file-card-icon) {
  @apply shrink-0 text-3xl;
  color: var(--card-icon-color);
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

.story-body :deep(.file-card-private) {
  --card-accent: var(--content-accent-private);
}

.story-body :deep(.file-card-redacted) {
  --card-accent: var(--content-accent-redacted);
}

/* Story reference cards have a brand strip, optional cover, title and rating.
   Dead references render a muted placeholder cover with an icon.
   The unpadded card clips the stacked brand, cover and content to its corners. */
.story-body :deep(.story-card) {
  @apply my-3 w-64 max-w-full flex-col items-stretch gap-0 overflow-hidden p-0;
}

.story-body :deep(.story-card-content) {
  @apply flex min-w-0 flex-1 flex-col gap-0.5 px-2.5 pb-2 pt-1;
}

/* The brand strip tracks the theme's primary color. */
.story-body :deep(.story-card) {
  @apply relative;
  --card-brand: theme('colors.primary');
  --card-accent: var(--card-brand);
}

.dark .story-body :deep(.story-card) {
  --card-brand: theme('colors.primary-600');
}

/* Each card opens with a brand strip; the card's overflow-hidden rounds its
   top corners, and covers keep their own overflow-hidden for the image. */
.story-body :deep(.story-card-brand) {
  @apply flex items-center gap-1.5 px-2 py-1 text-white;
  background-color: var(--card-brand);
}

.story-body :deep(.story-card-brand .iconify) {
  @apply h-3.5 w-3.5;
}

.story-body :deep(.story-card-brand-text) {
  @apply text-xs font-medium leading-4;
}

.story-body :deep(.story-card-out) {
  @apply ml-auto h-3.5 w-3.5 shrink-0 text-white/70;
}

.story-body :deep(.story-card-cover) {
  @apply relative shrink-0 overflow-hidden;
}

/* Reset the global story-body img rules (max-h cap, min-w floor, zoom
   cursor); the cover keeps its natural aspect ratio at full card width
   instead of being cropped to a fixed frame. */
.story-body :deep(.story-card-cover img) {
  @apply m-0 block h-auto max-h-none w-full min-w-0 cursor-pointer rounded-none;
}

/* Rating badge: a large, translucent tier SVG on its own row at the
   content's bottom right (self-end in the flex column), so the text keeps
   the full card width. The global story-body img rules (min-w floor, zoom
   cursor, rounding) are reset on the img. */
.story-body :deep(.story-card-rating) {
  @apply m-0 mt-1 h-6 w-auto min-w-0 max-w-none cursor-pointer self-end rounded-none opacity-30;
}

/* Center the story card's rows as boxes (same idiom as MyContent/StoryCard);
   once a row wraps, its lines lean left inside the shrink-wrapped box. */
.story-body :deep(.story-card-content) {
  @apply items-center;
}

/* Same wrap rule as StoryCard/StoryHeader: override the body's inherited
   overflow-wrap:anywhere with the gentler break-word; max-w-full caps the
   fit-content box at the card width so break-word can split a long unbroken
   word (items-center on the parent would otherwise let it size to the
   word's max-content width and overflow). */
.story-body :deep(.story-card-title),
.story-body :deep(.story-card-desc) {
  @apply min-w-0 max-w-full break-words;
}

.story-body :deep(.story-card-title) {
  @apply my-0.5 font-semibold text-slate-800 dark:text-slate-100;
}

.story-body :deep(.story-card-desc) {
  @apply mt-1 text-xs text-slate-500 dark:text-slate-400;
}

/* Tall images whose width would collapse under the max-h-64 cap are forced
   back up to min-w-48, and wide images whose height would collapse under
   max-w-full are forced back up to min-h-48; object-cover keeps the aspect
   ratio and object-top crops the resulting overflow at the bottom (tall) or
   both sides (wide). The min floors must stay fixed lengths: percentages are
   unresolvable in max-content contexts (carousel items, table cells), where
   they would silently disable the mechanism. Built-in card images (story
   covers, rating badges) carry .built-in-img and opt out — e.g. the
   rating badge's h-6 would otherwise lose to the min-h floor. */
.story-body :deep(img:not(.built-in-img)) {
  /* LQIP width/height attributes reserve the aspect ratio, not a fixed size. */
  @apply w-auto h-auto max-w-full max-h-64 min-w-32 min-h-32 cursor-zoom-in rounded-sm object-cover object-top;
}

/* The frame owns the image's corner shape and clips to it, so every layer
   inside — the crop hint included — traces the same corners. A caption below
   carries the bottom rounding, so a captioned frame squares its own bottom
   corners to meet it flush. */
.story-body :deep(.img-frame) {
  @apply relative inline-block w-fit overflow-hidden rounded-sm;
}

.story-body :deep(.carousel-item-captioned .img-frame) {
  @apply rounded-b-none;
}

.story-body :deep(.img-frame.content-cover) {
  @apply block w-full rounded-none;
}

/* Clipped by the frame, so the image carries no radius of its own here. */
.story-body :deep(.img-frame > img) {
  @apply rounded-none;
}

/* Reserve the same cropped box before the network image gains intrinsic
   dimensions. These limits match the image rules above; width/height HTML
   hints alone do not reserve this geometry in Chrome 80. */
.story-body :deep(.carousel-item .img-frame[data-image-sized]:not(.content-cover)) {
  max-width: 100%;
  width: max(theme('spacing.32'), min(var(--content-image-width), calc(theme('spacing.64') * var(--content-image-ratio))));
}

.story-body :deep(.carousel-item .img-frame[data-image-sized][aria-busy]:not(.content-cover))::after {
  padding-top: clamp(theme('spacing.32'), calc(100% / var(--content-image-ratio)), theme('spacing.64'));
}

.story-body :deep(.carousel-item .img-frame[data-image-sized][data-image-error]:not(.content-cover)) {
  width: auto;
}

.story-body :deep(.img-frame[data-image-error]) {
  @apply max-w-full;
}

/* Bottom-anchored gradient cover, shown only when JS confirms the image is
   actually clipped (data-cropped). Clicks fall through to the image. The
   long fade (pt-16) keeps the hint text on a solid enough background. */
.story-body :deep(.long-img-cover) {
  @apply pointer-events-none absolute inset-x-0 bottom-0 z-[2] flex items-end justify-center bg-gradient-to-t from-slate-950/90 via-slate-900/50 to-transparent px-2 pb-2 pt-16 text-center text-xs font-medium text-white;
  opacity: 0;
  transition: opacity var(--image-state-duration) var(--image-state-easing);
}

.story-body :deep(.img-frame[data-cropped][data-image-loaded] .long-img-cover) {
  opacity: 1;
}

/* Embedded covers and ratings take their hover brightness from the card. */
.story-body :deep(.story-card-cover img:hover),
.story-body :deep(.story-card-rating:hover) {
  @apply brightness-100;
}

.story-body :deep(.carousel-shell) {
  @apply relative my-4 max-w-full;
  /* Single source for the edge-fade width; nav jumps read it in JS too. */
  --carousel-fade-width: 3rem;
}

.story-body :deep(.carousel-shell-inline) {
  @apply my-1 inline-block align-middle;
}

/* Edge fades: while the strip can scroll in a direction, mask its content
   near that edge so the nav button floats over clear space and stays
   distinguishable. The carousel owner interpolates the numeric widths with
   the same 300ms ease curve on every supported engine. */

.story-body :deep(.image-carousel) {
  @apply m-0 flex items-end overflow-x-auto overflow-y-hidden pb-2;
  scrollbar-color: var(--content-accent-neutral) transparent;
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
}

/* Keep the inherited color from restyling code blocks and other scrollers. */
.story-body :deep(.image-carousel > *) {
  scrollbar-color: auto;
}

@supports not (scrollbar-color: auto) {
  .story-body :deep(.image-carousel::-webkit-scrollbar),
  .story-body :deep(.image-carousel::-webkit-scrollbar-track) {
    background: transparent;
  }

  .story-body :deep(.image-carousel::-webkit-scrollbar-thumb) {
    @apply rounded-full;
    background: var(--content-accent-neutral);
  }
}

/* Flex ignores whitespace-only text nodes between items. Each authored
   separator gets half an em so neighboring cards have room to breathe. */
.story-body :deep(.carousel-space) {
  @apply w-[0.5em] shrink-0 whitespace-pre;
}

.story-body :deep(.carousel-content-item) {
  @apply min-w-0 max-w-full shrink-0;
}

.story-body :deep(.carousel-content-item > :first-child) {
  margin-top: 0;
}

.story-body :deep(.carousel-content-item > :last-child) {
  margin-bottom: 0;
}

/* A heading inside a strip belongs to its item, not the page header stack. */
.story-body :deep(.image-carousel h1),
.story-body :deep(.image-carousel h2),
.story-body :deep(.image-carousel h3),
.story-body :deep(.image-carousel h4),
.story-body :deep(.image-carousel h5),
.story-body :deep(.image-carousel h6) {
  @apply static bg-transparent dark:bg-transparent;
  margin-inline: 0;
  padding-inline: 0;
}

.story-body :deep(.carousel-content-item > hr) {
  @apply w-24;
}

.story-body :deep(.carousel-nav) {
  @apply absolute top-[50%] z-10 flex h-9 w-9 -translate-y-1/2 cursor-pointer items-center justify-center rounded-full border border-white/25 bg-slate-900/70 text-xl text-white shadow-lg shadow-black/20 hover:bg-slate-900/90 dark:border-slate-900/20 dark:bg-white/75 dark:text-slate-900 dark:hover:bg-white/90 backdrop-blur-sm transition-all;
}

.story-body :deep(.carousel-nav:not([data-on='true'])) {
  @apply opacity-0 pointer-events-none;
}

/* Freshly wired shells apply their restored state transition-free for one
   frame, otherwise editor re-renders replay the fade/width animations. */
.story-body :deep(.carousel-no-fx .carousel-nav),
.story-body :deep(.carousel-no-fx .carousel-hint-text) {
  transition: none;
}

/* Keep the label in the flex layout so the pill can shrink with it. */
.story-body :deep(.carousel-hint-text) {
  @apply inline-flex max-w-0 shrink-0 flex-col overflow-hidden whitespace-nowrap text-left text-sm font-bold leading-tight opacity-0;
  transition: max-width 300ms ease-out, margin-right 300ms ease-out, opacity 160ms ease-out;
}

.story-body :deep(.carousel-next[data-on='true'][data-hint='true']) {
  @apply h-11 pl-4 pr-2.5;
}

.story-body :deep(.carousel-next[data-on='true'][data-hint='true']) .carousel-hint-text {
  @apply mr-1 max-w-[5.5em] opacity-100;
}

.story-body :deep(.carousel-hint-detail) {
  @apply text-[0.6875rem] font-normal leading-tight opacity-70;
}

.story-body :deep(.carousel-prev) {
  @apply -left-2;
}

.story-body :deep(.carousel-next) {
  @apply -right-2 w-auto min-w-9 overflow-hidden duration-300 ease-out;
  padding-inline: calc((2.25rem - 1em) / 2 - 1px);
}

.story-body :deep(.carousel-next > .iconify) {
  @apply shrink-0;
}

@media (prefers-reduced-motion: reduce) {
  .story-body :deep(.carousel-next),
  .story-body :deep(.carousel-hint-text) {
    transition: none;
  }
}

.story-body :deep(.carousel-shell-inline > .carousel-prev) {
  @apply left-0;
}

.story-body :deep(.carousel-shell-inline > .carousel-next) {
  @apply right-0;
}

/* Scroll-sync anchor for the strip's last line: a marker only, no box. */
.story-body :deep(.carousel-end-anchor) {
  @apply block h-0;
}

/* max-w-full caps the item at the strip's width: with shrink-0 the item
   would otherwise size to the image's max-content width, so the whole
   fit-content chain (item > .img-frame > img) never clamps and the img's
   own max-w-full resolves against that oversized box — overflowing the
   strip into a scroller even for a single image. */
.story-body :deep(.carousel-item) {
  @apply my-1 inline-flex max-w-full shrink-0 flex-col align-bottom;
}

.story-body :deep(.image-carousel .carousel-item) {
  @apply my-0;
}

/* The strip owns spacing for every card type. In particular, the private
   image's old block margin must not lift its visible bottom above its peers. */
.story-body :deep(.carousel-item > .private-image-block) {
  @apply m-0 flex max-w-full flex-col;
}

.story-body :deep(.image-carousel > .link-card),
.story-body :deep(.image-carousel > .content-placeholder),
.story-body :deep(.image-carousel > .private-inline) {
  @apply my-0 shrink-0;
}

.story-body :deep(.carousel-caption) {
  @apply w-0 min-w-full whitespace-normal break-words font-medium text-xs leading-[1.2rem] rounded-b-sm bg-slate-200 px-2.5 py-1.5 text-slate-600 dark:bg-slate-700 dark:text-slate-300;
}

.story-body :deep(.img-frame.iframe-frame) {
  @apply w-[32rem] max-w-full;
}

.story-body :deep(.iframe-frame iframe) {
  @apply absolute inset-0 block h-full w-full border-0 bg-slate-200 dark:bg-slate-700;
}

.story-body :deep(.iframe-frame)::after {
  content: '';
  display: block;
  padding-top: 56.25%;
}

.story-body :deep(.carousel-caption p) {
  @apply my-1;
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

/* Chips stay inline and wrap with the text flow; an overlong chip splits
   across lines instead of overflowing the card. */
.story-body :deep(code) {
  @apply rounded-sm border border-slate-300 dark:border-slate-600 bg-slate-100 px-[0.3em] py-[0.1em] font-mono text-[1em] dark:bg-slate-800;
}

.story-body :deep(pre) {
  @apply my-3 overflow-hidden border border-l-4 rounded-sm leading-5 border-slate-300 dark:border-slate-600 bg-slate-100 dark:bg-slate-800;
}

.story-body :deep(pre > .code-scroll) {
  @apply overflow-x-auto p-3;
}

.story-body :deep(pre code) {
  @apply m-0 whitespace-pre border-none bg-transparent p-0;
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
