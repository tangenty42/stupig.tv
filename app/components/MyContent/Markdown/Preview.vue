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
import { attachment_for_link, attachment_is_media, save_url_as } from '~/utils/content/attachment'
import { story_compiled_icons } from '~/utils/content/markdown/compiled-icons'

const props = withDefaults(defineProps<{
  markdown: string
  storyId?: number | null
  attachments?: ContentStoryAttachment[]
  folders?: string[]
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
const api = useApi()
const { error: toast_error } = useMyToast()
const preview_visible = ref(false)
const preview_index = ref(0)
const preview_images = ref<string[]>([])

const { body_markdown, render_result, preview_attachments } = useStoryPreview(() => props.markdown, {
  story_id: () => props.storyId,
  attachments: () => props.attachments,
  folders: () => props.folders,
  stories: () => props.stories,
  static_url,
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
watch(() => props.publicView, () => {
  preview_visible.value = false
  preview_images.value = []
  preview_index.value = 0
})

/** Saves a plaintext attachment under its row name instead of opening the nameless object URL. */
async function download_plain(attachment: ContentStoryAttachment) {
  const story_id = props.storyId
  if (! story_id)
    return
  try {
    const { url } = await api.content.sign_attachment_download(story_id, attachment.file_name)
    save_url_as(url)
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
    if (Number.isInteger(item_index) && item_index >= 0 && item_index < preview_images.value.length)
      preview_images.value[item_index] = item.src
  })
  preview_visible.value = true
}

function on_preview_click(event: MouseEvent) {
  const image = preview_image_from_event(event)
  if (image) {
    open_image_preview(image)
    return
  }
  // A plain attachment link saves under its row name; media stay viewable and
  // keep their native tab navigation.
  if (event.target instanceof HTMLElement) {
    const link = event.target.closest<HTMLAnchorElement>('a[href]')
    const attachment = link ? attachment_for_link(plain_attachments_by_url.value, link) : undefined
    if (attachment && ! attachment_is_media(attachment)) {
      event.preventDefault()
      void download_plain(attachment)
      return
    }
  }
  const folder = folder_from_event(event)
  if (folder) {
    emit('folder-open', folder)
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
    emit('folder-open', folder)
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

.story-body :deep(.link-card:not(.story-card-dead, .video-card, .story-card, .file-card-encrypted):hover),
.story-body :deep(.link-card:not(.story-card-dead, .video-card, .story-card, .file-card-encrypted):focus-visible) {
  @apply border-primary;
}

.story-body :deep(.link-card:not(.story-card-dead, .file-card-encrypted):hover) .link-card-open,
.story-body :deep(.link-card:not(.story-card-dead, .file-card-encrypted):hover) .link-card-icon,
.story-body :deep(.link-card:not(.story-card-dead, .file-card-encrypted):hover) .link-card-tag,
.story-body :deep(.link-card:not(.story-card-dead, .file-card-encrypted):focus-visible) .link-card-open,
.story-body :deep(.link-card:not(.story-card-dead, .file-card-encrypted):focus-visible) .link-card-icon,
.story-body :deep(.link-card:not(.story-card-dead, .file-card-encrypted):focus-visible) .link-card-tag {
  @apply text-primary;
}

.story-body :deep(.link-card-open) {
  @apply shrink-0 text-slate-400 transition-colors duration-300 dark:text-slate-500;
}

.story-body :deep(.link-card-icon),
.story-body :deep(.link-card-tag) {
  @apply shrink-0 font-medium text-slate-400 transition-colors duration-300 dark:text-slate-500;
}

/* A folder card is clickable only where the host can open the folder, and the
   data attribute marks exactly those. Without it the card is a plain label, so
   it keeps its resting border and colour rather than inviting a click. */
.story-body :deep(.folder-card[data-folder-card]) {
  @apply cursor-pointer;
}

.story-body :deep(.folder-card:not([data-folder-card]):hover) {
  @apply border-slate-300 brightness-100 dark:border-slate-600;
}

/* Plain-link chips flow like inline code: the chip breaks across lines
   mid-content instead of truncating, so it is a plain inline box and the
   flex gap is replaced by inner margins. Everything is em-sized so the chip
   scales with its context (smaller inside captions, bigger in headings). */
.story-body :deep(.link-chip) {
  @apply inline px-[0.625em] py-[0.25em] text-[0.875em] leading-[1.4];
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

.story-body :deep(.link-chip) .link-card-open {
  @apply ml-[0.4em];
}

/* Private (机密) content chrome, in the same dashed family as the link cards
   but amber to read as "restricted". Only ever rendered for viewers holding
   the content_private permission — everyone else's markdown arrives with the
   private elements already stripped by the server. */
.story-body :deep(.private-block) {
  @apply my-3 rounded-sm border border-dashed border-amber-400 bg-amber-50/40 dark:border-amber-600 dark:bg-amber-950/20;
}

.story-body :deep(.private-block-brand) {
  @apply flex items-center gap-1.5 border-b border-dashed border-amber-400 px-2 py-1 text-xs font-medium leading-4 text-amber-600 dark:border-amber-600 dark:text-amber-400;
}

.story-body :deep(.private-block-body) {
  @apply px-3 py-2;
}

.story-body :deep(.private-block-body > p) {
  @apply my-3;
}

/* The private chips are inline boxes too: they wrap mid-content like inline
   code, with inner margins instead of a flex gap. em-sized like link-chip. */
.story-body :deep(.private-inline),
.story-body :deep(.private-inline-denied) {
  @apply my-1 inline rounded-sm border border-dashed px-[0.625em] py-[0.25em] align-middle text-[0.875em] leading-[1.4];
}

.story-body :deep(.private-inline) {
  @apply border-amber-400 bg-amber-50/40 dark:border-amber-600 dark:bg-amber-950/20;
}

.story-body :deep(.private-inline-icon),
.story-body :deep(.private-inline-tag),
.story-body :deep(.private-inline-denied .iconify) {
  @apply mr-[0.25em];
}

.story-body :deep(.private-inline-icon),
.story-body :deep(.private-inline-tag) {
  @apply font-medium text-amber-600 dark:text-amber-400;
}

/* The placeholder an unauthorized viewer gets in place of a private element:
   same dashed silhouette, grayed out, with no private content inside. The
   server swaps the elements for this HTML before the markdown ever leaves. */
.story-body :deep(.private-block-denied) {
  @apply my-3 flex items-center gap-2 cursor-default rounded-sm border border-dashed border-slate-300 bg-slate-50/60 px-3 py-2 text-sm text-slate-400 dark:border-slate-600 dark:bg-slate-800/40 dark:text-slate-500;
}

/* html_wrappers re-renders the placeholder's inner as a paragraph. */
.story-body :deep(.private-block-denied > p) {
  @apply m-0 flex items-center gap-2 cursor-default;
}

.story-body :deep(.private-inline-denied) {
  @apply border-slate-300 bg-slate-50/60 text-slate-400 dark:border-slate-600 dark:bg-slate-800/40 dark:text-slate-500;
}

/* Encrypted attachments an unauthorized viewer meets: the image placeholder
   is a plain gray block; the denied file card keeps the file-card frame with
   a lock icon, only its title turns muted like the image placeholder's text. */
.story-body :deep(.encrypted-image-denied) {
  @apply flex min-h-40 w-full cursor-default flex-col items-center justify-center gap-2 rounded-sm bg-slate-100 px-6 py-10 text-sm text-slate-400 dark:bg-slate-800 dark:text-slate-500;
}

/* A caption below carries the bottom rounding, so the placeholder squares
   its own bottom to meet it flush (same split as captioned frames). */
.story-body :deep(.carousel-item-captioned .encrypted-image-denied) {
  @apply rounded-b-none;
}

.story-body :deep(.encrypted-card-denied) {
  @apply cursor-default;
}

.story-body :deep(.encrypted-card-denied .file-card-name) {
  @apply font-sans font-normal text-slate-400 dark:text-slate-500;
}

.story-body :deep(.encrypted-image-denied .iconify) {
  @apply text-3xl;
}

/* Permitted encrypted image: an amber cap above the normal picture/carousel
   body — dashed border on top/sides, rounded top; the frame below loses its
   top rounding (the same split as a caption's rounded bottom). */
.story-body :deep(.encrypted-block) {
  @apply my-3 block;
}

.story-body :deep(.encrypted-block-brand) {
  @apply flex items-center gap-1.5 rounded-t-sm border border-b-0 border-dashed border-amber-400 bg-amber-50/40 px-2 py-1 text-xs font-medium leading-4 text-amber-600 dark:border-amber-600 dark:bg-amber-950/20 dark:text-amber-400;
}

/* Inside the encrypted card the cap is full-width, so the shrink-wrapped
   frame (inline-block w-fit) must stretch too, or the card out-widens the
   image and the caption floats off to the side. */
.story-body :deep(.encrypted-block-brand ~ .img-frame),
.story-body :deep(.encrypted-block .img-frame) {
  @apply block w-full rounded-t-none;
}

.story-body :deep(.encrypted-block .img-frame > img) {
  @apply w-full;
}

/* Only the top rounding drops (the cap is above). display:block because the
   caption's width idiom (w-0 + min-w-full) is ignored on inline boxes —
   normally it is a direct flex child of the carousel item. */
.story-body :deep(.encrypted-block .carousel-caption) {
  @apply block rounded-t-none;
}

/* The frame shrink-wraps its image (inline-block w-fit); with the img hidden
   during decryption it would collapse around the loader — stretch it instead. */
.story-body :deep(.img-frame:has(> .encrypted-image-loading)) {
  @apply block w-full;
}

.story-body :deep(.encrypted-image-loading) {
  @apply flex min-h-40 w-full items-center justify-center bg-amber-50/40 text-3xl text-amber-500 dark:bg-amber-950/20;
}

.story-body :deep(.encrypted-image-loading .iconify) {
  @apply animate-spin;
}

/* The global img rules set display, which beats the [hidden] UA style — and
   the generic img[hidden] rule loses to .img-frame > img on specificity. */
.story-body :deep(.img-frame > img[hidden]) {
  @apply hidden;
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

/* Encrypted attachment card (key shipped): the same amber family as the
   private chrome. The denied variant stays gray — see .encrypted-card-denied. */
.story-body :deep(.file-card-encrypted) {
  @apply border-amber-400 bg-amber-50/40 dark:border-amber-600 dark:bg-amber-950/20;
}

.story-body :deep(.file-card-encrypted:hover),
.story-body :deep(.file-card-encrypted:focus-visible) {
  @apply border-amber-500 dark:border-amber-500;
}

.story-body :deep(.file-card-encrypted .file-card-icon) {
  @apply text-amber-600 dark:text-amber-400;
}

.story-body :deep(.file-card-encrypted-tag) {
  @apply ml-1 font-medium text-amber-600 dark:text-amber-400;
}

/* Video card and story reference card: vertical blocks like Bilibili's own
   feed card (and our carousel item) — a brand strip on top (pink 哔哩哔哩 /
   primary 蠢猪档案), then an optional full-width cover, then the title and
   a muted secondary line. The video card's cover carries play/like stats
   bottom-left and duration bottom-right; the story card sets its rating
   badge at the card's bottom right corner instead. Pending/failed fetches
   and dead references render a muted placeholder cover with an icon.
   The card is unpadded (.link-card's chrome is the 1px dashed border) and
   clips its sections to its own rounding, so brand/cover/content stack as
   plain flex sections — no negative-margin border compensation. */
.story-body :deep(.video-card),
.story-body :deep(.story-card) {
  /* The card itself draws no border: the brand strip and cover bleed to the
     edges, and only the bottom content section carries the dashed frame on
     its left/right/bottom. */
  @apply my-3 w-64 max-w-full flex-col items-stretch gap-0 overflow-hidden border-0 bg-transparent p-0;
}

/* The bottom section owns the card's dashed frame (left/right/bottom) and
   its bottom rounding; the top corners belong to the brand strip's clip.
   The transition matches the card's 300ms hover timing (it lives on the
   root's transition-all, which this border no longer rides). */
.story-body :deep(.video-card-content),
.story-body :deep(.story-card-content) {
  @apply flex min-w-0 flex-1 flex-col gap-0.5 rounded-b-sm border border-t-0 border-dashed border-slate-300 bg-slate-50/60 px-2.5 pb-2 pt-1 transition-colors duration-300 dark:border-slate-600 dark:bg-slate-800/40;
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

/* On hover the content section's border reveals the card's brand color; dead
   story cards are not links and stay static. */
.story-body :deep(.video-card:hover) .video-card-content,
.story-body :deep(.video-card:focus-visible) .video-card-content,
.story-body :deep(.story-card:not(.story-card-dead):hover) .story-card-content,
.story-body :deep(.story-card:not(.story-card-dead):focus-visible) .story-card-content {
  border-color: var(--card-brand);
}

/* Each card opens with a brand strip; the card's overflow-hidden rounds its
   top corners, and covers keep their own overflow-hidden for the image. */
.story-body :deep(.video-card-brand),
.story-body :deep(.story-card-brand) {
  @apply flex items-center gap-1.5 px-2 py-1 text-white;
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
  @apply relative shrink-0 overflow-hidden bg-slate-200 dark:bg-slate-700;
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
  /* LQIP width/height attributes reserve the aspect ratio, not a fixed size. */
  @apply w-auto h-auto max-w-full max-h-64 min-w-32 min-h-32 cursor-zoom-in rounded-sm object-cover object-top transition-[filter] duration-300;
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
  @apply block rounded-none;
  opacity: 0;
  transition: opacity 200ms ease, filter 300ms ease;
}

.story-body :deep(.image-loading-mask) {
  @apply pointer-events-none absolute inset-0 flex items-center justify-center bg-slate-100/70 text-xl text-slate-500 dark:bg-slate-900/70 dark:text-slate-400;
}

.story-body :deep(.image-loading-mask .iconify) {
  @apply animate-spin motion-reduce:animate-none;
}

.story-body :deep(.img-frame:is([data-image-loaded], [data-image-error]) .image-loading-mask) {
  @apply hidden;
}

.story-body :deep(.img-frame[data-lqip]::before) {
  content: '';
  @apply pointer-events-none absolute inset-0;
  background: var(--content-lqip) center / cover no-repeat;
  filter: blur(0.5rem);
  transform: scale(1.05);
  transition: opacity 200ms ease;
}

.story-body :deep(.img-frame[data-lqip]:is([data-image-loaded], [data-image-error])::before) {
  opacity: 0;
}

.story-body :deep(.img-frame:is([data-image-loaded], [data-image-error]) > img) {
  opacity: 1;
}

.story-body :deep(.image-unavailable) {
  @apply hidden aspect-video w-64 max-w-full items-center justify-center bg-slate-200 text-3xl text-slate-400 dark:bg-slate-800 dark:text-slate-500;
}

.story-body :deep(.img-frame[data-image-error]) {
  @apply max-w-full;
}

.story-body :deep(.img-frame[data-image-error] > img) {
  @apply hidden;
}

.story-body :deep(.img-frame[data-image-error] > .image-unavailable) {
  @apply flex;
}

@media (prefers-reduced-motion: reduce) {
  .story-body :deep(.img-frame[data-lqip]::before),
  .story-body :deep(.img-frame > img) {
    transition: none;
  }
}

/* Bottom-anchored gradient cover, shown only when JS confirms the image is
   actually clipped (data-cropped). Clicks fall through to the image. The
   long fade (pt-16) keeps the hint text on a solid enough background. */
.story-body :deep(.long-img-cover) {
  @apply pointer-events-none absolute inset-x-0 bottom-0 hidden items-end justify-center bg-gradient-to-t from-slate-950/90 via-slate-900/50 to-transparent px-2 pb-2 pt-16 text-center text-xs font-medium text-white;
}

.story-body :deep(.img-frame[data-cropped][data-image-loaded] .long-img-cover) {
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

.story-body :deep(.carousel-nav:not([data-on='true'])) {
  @apply opacity-0 pointer-events-none;
}

/* Freshly wired shells apply their restored state transition-free for one
   frame, otherwise editor re-renders replay the fade/width animations. */
.story-body :deep(.carousel-no-fx .carousel-nav),
.story-body :deep(.carousel-no-fx .image-carousel) {
  transition: none;
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
  @apply flex max-w-full shrink-0 flex-col;
}

.story-body :deep(.carousel-caption) {
  @apply w-0 min-w-full whitespace-normal break-words font-medium text-xs leading-[1.2rem] rounded-b-sm bg-slate-200/80 px-2.5 py-1.5 text-slate-600 dark:bg-slate-800/60 dark:text-slate-300;
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
