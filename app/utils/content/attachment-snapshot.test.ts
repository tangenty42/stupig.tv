import type { ContentAttachmentWorkspace } from '@shared/types/content'
import { describe, expect, it } from 'vitest'
import { accept_attachment_snapshot } from './attachment-snapshot'

const snapshot: ContentAttachmentWorkspace = { attachments: [], folders: [], namespace_revision: 5, viewer_key: '1:true' }

describe('attachment snapshots', () => {
  it('rejects a delayed older namespace for the same viewer', () => {
    const current = { ... snapshot }
    expect(accept_attachment_snapshot(current, { ... snapshot, namespace_revision: 4 })).toBe(current)
  })
  it('accepts equal-version lock/projection refreshes and newer namespace versions', () => {
    const equal = { ... snapshot, folders: ['folder'] }
    expect(accept_attachment_snapshot(snapshot, equal)).toBe(equal)
    const newer = { ... snapshot, namespace_revision: 6 }
    expect(accept_attachment_snapshot(snapshot, newer)).toBe(newer)
  })
  it('accepts an identity change so logout cannot retain the old authorized projection', () => {
    const guest = { ... snapshot, namespace_revision: 4, viewer_key: 'anon:false' }
    expect(accept_attachment_snapshot(snapshot, guest)).toBe(guest)
    expect(accept_attachment_snapshot(null, guest)).toBe(guest)
  })
})
