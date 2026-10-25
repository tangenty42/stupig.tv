import type { ContentAttachmentWorkspace } from '@shared/types/content'

/** Viewer changes require a fresh projection even when its namespace is older. */
export function accept_attachment_snapshot(current: ContentAttachmentWorkspace | null, incoming: ContentAttachmentWorkspace) {
  if (current && current.viewer_key === incoming.viewer_key && incoming.namespace_revision < current.namespace_revision)
    return current
  return incoming
}
