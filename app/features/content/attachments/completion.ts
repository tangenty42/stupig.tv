import type { ContentStoryAttachment } from '@shared/types/content'

/** Pending uploads retain a ticket, not a destroyed editor's callback closure. */
export function create_upload_completion_context() {
  const callbacks = new Map<symbol, (attachment: ContentStoryAttachment) => void>()
  let disposed = false
  function bind(callback: (attachment: ContentStoryAttachment) => void) {
    const ticket = Symbol('upload-completion')
    if (! disposed)
      callbacks.set(ticket, callback)
    return (attachment: ContentStoryAttachment) => {
      const deliver = callbacks.get(ticket)
      callbacks.delete(ticket)
      deliver?.(attachment)
    }
  }
  return { bind, reset: () => callbacks.clear(), dispose: () => {
    disposed = true
    callbacks.clear()
  } }
}
