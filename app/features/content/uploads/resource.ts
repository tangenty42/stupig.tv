import type { ContentUploadReservation, ContentUploadSession } from '@shared/types/content-upload'

/** The synchronized server resource has one owner; Pinia only exposes its projection. */
export function createContentUploadResource(scope: number) {
  const state = useState(`content_upload_resource:${scope}`, () => ({ enabled: false, ready: false, sessions: [] as ContentUploadSession[], reservations: [] as ContentUploadReservation[] }))
  const removed = new Set<string>()
  function update(session: ContentUploadSession) {
    if (removed.has(session.id))
      return
    const previous = state.value.sessions.find(item => item.id === session.id)
    if (previous && (previous.revision ?? 0) > (session.revision ?? 0))
      return
    state.value.sessions = [... state.value.sessions.filter(item => item.id !== session.id), session]
  }
  function merge(value: { enabled: boolean, sessions: ContentUploadSession[], reservations?: ContentUploadReservation[] }) {
    state.value.enabled = value.enabled
    state.value.ready = true
    state.value.reservations = value.reservations ?? []
    const missing = state.value.sessions.filter(session => ! value.sessions.some(item => item.id === session.id))
    for (const session of value.sessions)
      update(session)
    // Absence alone cannot erase a just-accepted upload: confirm through its ID.
    return missing
  }
  function remove(id: string) {
    removed.add(id)
    state.value.sessions = state.value.sessions.filter(item => item.id !== id)
    state.value.reservations = state.value.reservations.filter(item => item.id !== id)
  }
  function reset() {
    removed.clear()
    state.value = { enabled: false, ready: false, sessions: [], reservations: [] }
  }
  return { state, update, merge, remove, reset, removed }
}
