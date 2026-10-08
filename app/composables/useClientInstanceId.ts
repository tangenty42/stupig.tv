/**
 * The browser installation's own id, persisted in localStorage so it survives a
 * refresh and is shared by every tab.
 *
 * It exists for one purpose only: letting the editor say "this machine still
 * has the file, resume from here" (docs/content-task-refactor.md §9). It is not
 * an authorization boundary — any client holding the source file may resume a
 * task — so a client that loses this id simply loses the hint, not access.
 *
 * Deliberately NOT the sync client id: that one lives in sessionStorage and is
 * per-tab, so it cannot recognise the same browser after a refresh.
 */
export function useClientInstanceId() {
  if (import.meta.server)
    return null

  const config = useRuntimeConfig().public
  const key = config.content_task_client_id_storage_name

  try {
    const existing = localStorage.getItem(key)
    if (existing)
      return existing
    const created = crypto.randomUUID()
    localStorage.setItem(key, created)
    return created
  }
  catch {
    // Private-mode or blocked storage: the upload still works, it just cannot
    // advertise itself as resumable on a later visit.
    return null
  }
}
