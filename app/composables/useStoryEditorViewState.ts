import type { StoryEditorPosition, StoryEditorViewState } from '~/utils/content/editor/view-state'
import { default_editor_view_state, parse_editor_view_state } from '~/utils/content/editor/view-state'

interface EditorViewStateOptions {
  key: () => string | null | undefined
  fullscreen: Ref<boolean>
  mode: Ref<'edit' | 'preview'>
  audience: Ref<'private' | 'public'>
  split_ratio: Ref<number>
  attachments_width: Ref<number>
  capture: () => StoryEditorPosition | null
  restore: (position: StoryEditorPosition) => void
}

/** Browser-only presentation preferences, scoped to one account and cloud draft. */
export function useStoryEditorViewState(options: EditorViewStateOptions) {
  let key: string | null = null
  let mounted = false
  let disposed = false

  function save() {
    if (! mounted || ! key)
      return
    const state: StoryEditorViewState = {
      version: 1, fullscreen: options.fullscreen.value, mode: options.mode.value, audience: options.audience.value,
      split_ratio: options.split_ratio.value, attachments_width: options.attachments_width.value, position: options.capture(),
    }
    try {
      localStorage.setItem(key, JSON.stringify(state))
    }
    catch { /* Storage denial/quota must not interrupt editing or cloud saves. */ }
  }

  function hidden() {
    if (document.visibilityState === 'hidden')
      save()
  }

  onMounted(async () => {
    const scope = options.key()
    key = scope ? `stupig:editor-view:${scope}` : null
    let state = default_editor_view_state()
    if (key) {
      try {
        state = parse_editor_view_state(JSON.parse(localStorage.getItem(key) ?? 'null')) ?? state
      }
      catch { /* Ignore malformed or unavailable presentation state. */ }
    }
    options.fullscreen.value = state.fullscreen
    options.mode.value = state.mode
    options.audience.value = state.audience
    options.split_ratio.value = state.split_ratio
    options.attachments_width.value = state.attachments_width
    window.addEventListener('pagehide', save)
    document.addEventListener('visibilitychange', hidden)
    // CodeMirror mounts and Teleport/layout settle before restoring its viewport.
    await nextTick()
    if (disposed)
      return
    if (state.position)
      options.restore(state.position)
    mounted = true
  })

  // Registered before the CodeMirror owner's destroy hook by the component.
  onBeforeUnmount(() => {
    save()
    disposed = true
    mounted = false
    window.removeEventListener('pagehide', save)
    document.removeEventListener('visibilitychange', hidden)
  })
}
