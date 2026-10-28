import type { ContentReferenceBaseline, ContentReferenceRewriteResult } from '@shared/types/content-reference'

export interface DraftReferenceSnapshot extends ContentReferenceBaseline {
  local_revision: number
  story_id: number
  viewer_key: string
  markdown: string
  namespace_revision: number
  title_revision: number
  saving: boolean
}

/** Serialize requests; apply only to exactly the snapshot the server inspected. */
export function create_draft_reference_bridge(options: {
  snapshot: () => DraftReferenceSnapshot | null
  rewrite: (snapshot: DraftReferenceSnapshot) => Promise<ContentReferenceRewriteResult>
  apply: (snapshot: DraftReferenceSnapshot, result: ContentReferenceRewriteResult) => boolean
  on_error: (error: unknown) => void
  on_pending?: (pending: boolean) => void
}) {
  let running = false
  let stopped = false
  let requested = false
  let last_attempt = ''
  let last_history_unavailable = false
  let generation = 0
  let pending = false
  let retry_timer: ReturnType<typeof setTimeout> | null = null
  let force_next = false
  function set_pending(value: boolean) {
    if (pending === value)
      return
    pending = value
    options.on_pending?.(value)
  }
  const version_key = (snapshot: DraftReferenceSnapshot) => JSON.stringify([snapshot.story_id, snapshot.viewer_key, snapshot.namespace_revision, snapshot.title_revision, snapshot.base_namespace_revision, snapshot.base_title_revision,
    last_history_unavailable ? null : snapshot.markdown,
  ])

  async function request() {
    if (stopped)
      return
    requested = true
    if (running)
      return
    running = true
    try {
      while (requested) {
        if (stopped)
          break
        requested = false
        const snapshot = options.snapshot()
        if (! snapshot || snapshot.saving)
          continue
        const key = version_key(snapshot)
        if (! force_next && snapshot.base_namespace_revision === snapshot.namespace_revision && snapshot.base_title_revision === snapshot.title_revision)
          continue
        if (! force_next && last_attempt === key)
          continue
        const epoch = generation
        force_next = false
        try {
          set_pending(true)
          const result = await options.rewrite(snapshot)
          const current = options.snapshot()
          if (stopped || epoch !== generation)
            continue
          if (! current || current.saving || JSON.stringify(current) !== JSON.stringify(snapshot)) {
            requested = true
            continue
          }
          if (options.apply(snapshot, result)) {
            last_history_unavailable = result.baseline_unavailable.namespace || result.baseline_unavailable.title
            const after = options.snapshot()
            last_attempt = after ? version_key(after) : key
          }
        }
        catch (error) {
          if (! stopped && epoch === generation) {
            force_next = true
            options.on_error(error)
            if (! retry_timer) {
              retry_timer = setTimeout(() => {
                retry_timer = null
                void request()
              }, 3000)
            }
          }
        }
      }
    }
    finally {
      running = false
      set_pending(false)
    }
  }
  return {
    request,
    invalidate(force = false) {
      generation ++
      last_attempt = ''
      last_history_unavailable = false
      force_next = force
      if (retry_timer) {
        clearTimeout(retry_timer)
        retry_timer = null
      }
    },
    stop() {
      stopped = true
      generation ++
      if (retry_timer)
        clearTimeout(retry_timer)
      retry_timer = null
      set_pending(false)
    },
  }
}
