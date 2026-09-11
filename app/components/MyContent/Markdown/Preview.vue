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
import type { RenderEnvironment } from '~/utils/content/markdown/types'
import { strip_front_matter } from '@shared/content-markdown'
import { alert_icons } from '~/utils/content/alerts'
import { file_icon_names } from '~/utils/content/attachment'
import { setup_carousels } from '~/utils/content/carousel'
import { observe_cropped_images } from '~/utils/content/cropped-images'
import { create_story_markdown } from '~/utils/content/markdown'
import { compensate_section_push, layout_heading_offsets, observe_heading_layout, wrap_heading_sections } from '~/utils/content/sticky-headings'

const props = withDefaults(defineProps<{
  markdown: string
  storyId?: number | null
  attachments?: ContentStoryAttachment[]
  emptyText?: string
  /** Known stories so `[](@title)` references render as story cards. */
  stories?: ContentStorySummary[]
  /**
   * Set by a host that can act on a folder card (reveal the folder in its
   * attachment list). Left off, the card renders inert.
   */
  folderOpenable?: boolean
}>(), {
  storyId: null,
  attachments: () => [],
  emptyText: '',
  stories: () => [],
  folderOpenable: false,
})

const emit = defineEmits<{
  /** A folder card was activated; the host decides where the folder opens. */
  'folder-open': [folder: string]
}>()

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
  // The folder card's leading icon.
  'lucide:folder',
]

const static_url = useStaticUrl()
const api = useApi()
const body_markdown = computed(() => strip_front_matter(props.markdown))
const preview_visible = ref(false)
const preview_index = ref(0)

// href -> card metadata; undefined = not fetched yet, null = fetch failed.
// useState so SSR-fetched cards cross the payload boundary and hydrate
// identically, and so instances across pages share one cache.
const video_cards = useState<Record<string, BilibiliVideoCard | null>>('content_bilibili_video_cards', () => ({}))

// The renderer preset (source anchors, alerts, carousels, link/file/video/
// story cards, code scroll wrappers, html wrappers) lives in
// app/utils/content/markdown as markdown-it plugins; the getters below keep
// renders reactive to the props and the video card cache.
const md = create_story_markdown({
  story_id: () => props.storyId,
  attachments: () => props.attachments,
  stories: () => props.stories,
  static_url,
  video_card: href => video_cards.value[href],
  folder_card_openable: () => props.folderOpenable,
})

const render_result = computed(() => {
  const environment: RenderEnvironment = { images: [], bilibili_hrefs: [] }
  return {
    html: md.render(body_markdown.value, environment),
    images: environment.images,
    bilibili_hrefs: environment.bilibili_hrefs,
  }
})

async function fetch_missing_video_cards(hrefs: string[]) {
  const missing = [... new Set(hrefs)].filter(href => ! (href in video_cards.value))
  if (! missing.length) {
    return
  }
  try {
    const cards = await api.content.get_bilibili_video_cards(missing)
    video_cards.value = { ... video_cards.value, ... cards }
  }
  catch {
    // The request itself failed (offline, server down): keep the
    // placeholder cards; the next render change retries the fetch.
  }
}

// SSR: Vue awaits onServerPrefetch hooks before rendering, so the first
// paint carries real cards; upstream responses are Redis-cached server-side,
// so warm previews add no upstream latency.
onServerPrefetch(() => fetch_missing_video_cards(render_result.value.bilibili_hrefs))

// Client: hydration finds the hrefs already in the serialized state and
// skips; later link-set changes (editor typing, SPA navigation) refetch.
watch(() => render_result.value.bilibili_hrefs, (hrefs) => {
  if (import.meta.client) {
    void fetch_missing_video_cards(hrefs)
  }
}, { immediate: true })

/** The folder a click/keypress targets, or null when it is not a folder card. */
function folder_from_event(event: Event) {
  if (! (event.target instanceof HTMLElement)) {
    return null
  }
  return event.target.closest<HTMLElement>('[data-folder-card]')?.dataset.folderCard ?? null
}

const story_body = useTemplateRef<HTMLElement>('story_body')

// Post-render DOM behaviors (carousel wiring, sticky heading sections,
// cropped-image markers) live in app/utils/content/*; here we only
// orchestrate them after each render and keep their cleanup handles.
let cleanup_crop_observer: (() => void) | null = null
let cleanup_body_observer: (() => void) | null = null

function refresh_story_body() {
  cleanup_crop_observer?.()
  cleanup_crop_observer = null
  cleanup_body_observer?.()
  cleanup_body_observer = null
  const body = story_body.value
  if (! body) {
    return
  }
  wrap_heading_sections(body)
  compensate_section_push(body)
  layout_heading_offsets(body)
  setup_carousels(body)
  cleanup_crop_observer = observe_cropped_images(body)
  cleanup_body_observer = observe_heading_layout(body)
}

// Re-run the DOM behaviors once the rendered HTML is in the DOM, and
// whenever it re-renders.
watch(render_result, () => {
  nextTick(refresh_story_body)
}, { flush: 'post' })

function on_window_resize() {
  if (story_body.value) {
    layout_heading_offsets(story_body.value)
  }
}

onMounted(() => {
  nextTick(refresh_story_body)
  window.addEventListener('resize', on_window_resize)
})

onUnmounted(() => {
  cleanup_body_observer?.()
  cleanup_crop_observer?.()
  window.removeEventListener('resize', on_window_resize)
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
    return
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

/* A folder card is clickable only where the host can open the folder, and the
   data attribute marks exactly those. Without it the card is a plain label, so
   it keeps its resting border and colour rather than inviting a click. */
.story-body :deep(.folder-card[data-folder-card]) {
  @apply cursor-pointer;
}

.story-body :deep(.folder-card:not([data-folder-card]):hover) {
  @apply border-slate-300 brightness-100 dark:border-slate-600;
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
