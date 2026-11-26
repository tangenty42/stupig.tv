import type { ContentStoryAttachment } from '@shared/types/content'

/** Pending uploads retain a ticket, not a destroyed editor's callback closure. */
export function create_upload_completion_context() {
  let callbacks = new WeakMap<object, (attachment: ContentStoryAttachment) => void>()
  let disposed = false
  function bind(callback: (attachment: ContentStoryAttachment) => void) {
    const ticket = {}
    if (! disposed)
      callbacks.set(ticket, callback)
    return (attachment: ContentStoryAttachment) => {
      const deliver = callbacks.get(ticket)
      callbacks.delete(ticket)
      deliver?.(attachment)
    }
  }
  function reset() {
    callbacks = new WeakMap()
  }
  return { bind, reset, dispose: () => {
    disposed = true
    reset()
  } }
}
