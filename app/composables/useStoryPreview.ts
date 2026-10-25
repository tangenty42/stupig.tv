import type { BilibiliVideoCard } from '@shared/types/bilibili'
import type { RenderEnvironment, StoryMarkdownOptions } from '~/utils/content/markdown/types'
import { strip_front_matter } from '@shared/content-markdown'
import { redact_private_content_with_source_map } from '@shared/content-private'
import { settings } from '@shared/settings'
import { public_preview_attachments } from '~/utils/content/attachment'
import { create_story_markdown } from '~/utils/content/markdown'

type VideoCards = Record<string, BilibiliVideoCard | null>

// Promises never enter the serialized payload. Each SSR request / client app
// owns its in-flight requests; previews in that app join overlapping batches.
const pending_by_app = new WeakMap<object, Map<string, Promise<VideoCards>>>()

/** Owns reactive rendering and video metadata; no DOM or interaction state. */
export function useStoryPreview(markdown: () => string, options: Omit<StoryMarkdownOptions, 'video_card'> & { public_view?: () => boolean }) {
  const api = useApi()
  const app = useNuxtApp()
  // undefined = not fetched, null = upstream returned no card. SSR cards must
  // cross the payload boundary so hydration starts with the same rendered HTML.
  const video_cards = useState<VideoCards>('content_bilibili_video_cards', () => ({}))
  const retry_at = useState<Record<string, number>>('content_bilibili_video_retry_at', () => ({}))
  let pending = pending_by_app.get(app)
  if (! pending) {
    pending = new Map()
    pending_by_app.set(app, pending)
  }
  const requests = pending
  let disposed = false
  let mounted = false
  let retry_timer: ReturnType<typeof setTimeout> | undefined
  const body_representation = computed(() => {
    const body = strip_front_matter(markdown())
    return options.public_view?.() ? redact_private_content_with_source_map(body) : { markdown: body }
  })
  const body_markdown = computed(() => body_representation.value.markdown)
  const preview_attachments = computed(() => options.public_view?.() ? public_preview_attachments(options.attachments()) : options.attachments())
  const md = create_story_markdown({ ... options, attachments: () => preview_attachments.value, video_card: href => video_cards.value[href] })
  const render_result = computed(() => {
    const environment: RenderEnvironment = { images: [], bilibili_hrefs: [] }
    const html = md.render(body_markdown.value, environment)
    const source_lines = 'source_lines' in body_representation.value ? body_representation.value.source_lines : undefined
    return {
      // Only renderer-owned source annotations change; public pixels and text
      // stay identical to the unprivileged representation used by the server.
      html: source_lines ? html.replace(/ data-line="(\d+)"/g, (_attribute, line: string) => ` data-line="${source_lines[Number(line)] ?? line}"`) : html,
      images: environment.images,
      bilibili_hrefs: environment.bilibili_hrefs,
    }
  })

  function schedule_retry() {
    clearTimeout(retry_timer)
    if (! mounted || disposed)
      return
    const deadlines = [... new Set(render_result.value.bilibili_hrefs)].filter(href => video_cards.value[href] === null).map((href) => {
      // Payloads from older deployments have nulls without an expiry.
      return retry_at.value[href] ??= Date.now() + settings.integrations.bilibili.negativeCacheTtlMs
    })
    if (deadlines.length) {
      retry_timer = setTimeout(() => {
        void fetch_missing_video_cards(render_result.value.bilibili_hrefs)
      }, Math.max(1, Math.min(... deadlines) - Date.now()))
    }
  }

  async function fetch_missing_video_cards(hrefs: string[]) {
    if (disposed)
      return
    const missing = [... new Set(hrefs)].filter(href => ! (href in video_cards.value)
      || (video_cards.value[href] === null && (requests.has(href) || (retry_at.value[href] !== undefined && retry_at.value[href]! <= Date.now()))))
    const fresh = missing.filter(href => ! requests.has(href))
    if (fresh.length) {
      // Even a transport failure during a negative retry must wait out the
      // next window rather than reschedule against an already-expired date.
      for (const href of fresh) {
        if (video_cards.value[href] === null)
          retry_at.value[href] = Date.now() + settings.integrations.bilibili.negativeCacheTtlMs
      }
      const request = api.content.get_bilibili_video_cards(fresh)
        .catch(() => ({} as VideoCards))
      for (const href of fresh)
        requests.set(href, request)
      // Remove failed flights as well; negative results have a bounded retry.
      void request.then(() => {
        for (const href of fresh) {
          if (requests.get(href) === request)
            requests.delete(href)
        }
      })
    }
    const flights = new Set(missing.map(href => requests.get(href)!))
    await Promise.all([... flights].map(async (request) => {
      const cards = await request
      // Another preview may still need the shared request; unmount only
      // releases this consumer, without cancelling work it does not own.
      if (disposed)
        return
      for (const [href, card] of Object.entries(cards)) {
        if (card === null)
          retry_at.value[href] = Date.now() + settings.integrations.bilibili.negativeCacheTtlMs
        else
          delete retry_at.value[href]
      }
      const updates = Object.fromEntries(Object.entries(cards).filter(([href, card]) => ! (href in video_cards.value) || (video_cards.value[href] === null && card !== null)))
      if (Object.keys(updates).length)
        video_cards.value = { ... video_cards.value, ... updates }
    }))
    schedule_retry()
  }

  onServerPrefetch(() => fetch_missing_video_cards(render_result.value.bilibili_hrefs))
  watch(() => render_result.value.bilibili_hrefs, (hrefs) => {
    if (import.meta.client)
      void fetch_missing_video_cards(hrefs)
  }, { immediate: true })
  onMounted(() => {
    mounted = true
    schedule_retry()
  })
  onScopeDispose(() => {
    disposed = true
    clearTimeout(retry_timer)
  })

  return { body_markdown, render_result, preview_attachments }
}
