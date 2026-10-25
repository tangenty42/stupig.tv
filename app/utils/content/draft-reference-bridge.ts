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

/** Advancing aggregate baselines must not release another still-missing tombstone. */
export function reference_review_can_confirm(result: ContentReferenceRewriteResult) {
  return result.diagnostics.some(item => item.reason === 'replaced') && ! result.diagnostics.some(item => item.reason === 'missing')
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
  let generation = 0
  let pending = false
  function set_pending(value: boolean) {
    if (pending === value)
      return
    pending = value
    options.on_pending?.(value)
  }
  const version_key = (snapshot: DraftReferenceSnapshot) => JSON.stringify([snapshot.story_id, snapshot.viewer_key, snapshot.namespace_revision, snapshot.title_revision, snapshot.base_namespace_revision, snapshot.base_title_revision,
    // Known pinned baselines may recover after the user removes a dead link.
    snapshot.base_namespace_revision !== null && snapshot.base_title_revision !== null ? snapshot.markdown : null,
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
        if (snapshot.base_namespace_revision === snapshot.namespace_revision && snapshot.base_title_revision === snapshot.title_revision)
          continue
        if (last_attempt === key)
          continue
        const epoch = generation
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
            // Unknown/expired baselines stay unknown. Do not retry on every keystroke.
            const after = options.snapshot()
            last_attempt = after ? version_key(after) : key
          }
        }
        catch (error) {
          if (! stopped && epoch === generation) {
            last_attempt = key
            options.on_error(error)
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
    invalidate() {
      generation ++
      last_attempt = ''
    },
    stop() {
      stopped = true
      generation ++
      set_pending(false)
    },
  }
}
