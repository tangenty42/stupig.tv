import { watch } from 'vue'

/** Only attach beforeunload while there is unsaved text so clean pages can use bfcache. */
export function watch_draft_beforeunload(has_unconfirmed_changes: () => boolean) {
  function warn(event: BeforeUnloadEvent) {
    if (has_unconfirmed_changes()) {
      event.preventDefault()
      event.returnValue = true
    }
  }

  return watch(has_unconfirmed_changes, (dirty, _previous, on_cleanup) => {
    if (dirty) {
      window.addEventListener('beforeunload', warn)
      on_cleanup(() => window.removeEventListener('beforeunload', warn))
    }
  }, { immediate: true, flush: 'sync' })
}
