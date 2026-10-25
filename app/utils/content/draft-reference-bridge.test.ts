import type { ContentReferenceRewriteResult } from '@shared/types/content-reference'
import type { DraftReferenceSnapshot } from './draft-reference-bridge'
import { describe, expect, it, vi } from 'vitest'
import { create_draft_reference_bridge, reference_review_can_confirm } from './draft-reference-bridge'

const initial: DraftReferenceSnapshot = {
  local_revision: 0,
  story_id: 1, viewer_key: '1', markdown: 'old', namespace_revision: 2, title_revision: 3,
  base_namespace_revision: 0, base_title_revision: 0, saving: false,
}
const response: ContentReferenceRewriteResult = {
  markdown: 'new', changes: [{ from: 0, to: 3, insert: 'new' }], diagnostics: [],
  base_namespace_revision: 2, base_title_revision: 3, namespace_revision: 2, title_revision: 3,
  baseline_unavailable: { namespace: false, title: false },
}

describe('draft reference bridge', () => {
  it('holds the editor lock through a slow response, stale retry and applying the latest result', async () => {
    let current = { ... initial }
    let finish!: (value: ContentReferenceRewriteResult) => void
    const pending = vi.fn()
    const rewrite = vi.fn().mockImplementationOnce(() => new Promise((resolve) => {
      finish = resolve
    })).mockResolvedValue(response)
    const apply = vi.fn(() => {
      expect(pending.mock.calls).toEqual([[true]])
      current = { ... current, ... response }
      return true
    })
    const bridge = create_draft_reference_bridge({ snapshot: () => current, rewrite, apply, on_error: vi.fn(), on_pending: pending })
    const request = bridge.request()
    expect(pending.mock.calls).toEqual([[true]])
    current = { ... current, local_revision: 1, markdown: 'external update' }
    await bridge.request()
    finish(response)
    await request
    expect(rewrite).toHaveBeenCalledTimes(2)
    expect(apply).toHaveBeenCalledTimes(1)
    expect(pending.mock.calls).toEqual([[true], [false]])
    await bridge.request()
    expect(pending).toHaveBeenCalledTimes(2)
  })

  it.each(['failure', 'stop'])('releases the editor lock on %s without applying stale text', async (mode) => {
    let reject!: (reason: Error) => void
    const pending = vi.fn()
    const apply = vi.fn()
    const on_error = vi.fn()
    const bridge = create_draft_reference_bridge({ snapshot: () => initial, rewrite: () => new Promise((_resolve, fail) => {
      reject = fail
    }), apply, on_error, on_pending: pending })
    const request = bridge.request()
    expect(pending.mock.calls).toEqual([[true]])
    if (mode === 'stop') {
      bridge.stop()
      expect(pending.mock.calls).toEqual([[true], [false]])
    }
    reject(new Error('offline'))
    await request
    expect(pending.mock.calls).toEqual([[true], [false]])
    expect(apply).not.toHaveBeenCalled()
    expect(on_error).toHaveBeenCalledTimes(mode === 'failure' ? 1 : 0)
  })

  it('does not release missing tombstones when another reference is confirmed against a new owner', () => {
    const replaced = { kind: 'attachment' as const, target: 'new.png', from: 0, to: 10, line: 1, reason: 'replaced' as const }
    expect(reference_review_can_confirm({ ... response, diagnostics: [replaced] })).toBe(true)
    expect(reference_review_can_confirm({ ... response, diagnostics: [replaced, { ... replaced, target: 'missing.png', reason: 'missing' }] })).toBe(false)
    expect(reference_review_can_confirm(response)).toBe(false)
  })
  it('discards a response after typing and serializes a retry of the newest snapshot', async () => {
    let current = { ... initial }
    let resolve!: (value: ContentReferenceRewriteResult) => void
    const rewrite = vi.fn().mockImplementationOnce(() => new Promise((done) => {
      resolve = done
    })).mockResolvedValue(response)
    const apply = vi.fn((snapshot: DraftReferenceSnapshot) => {
      expect(snapshot.markdown).toBe('typed')
      current = { ... current, ... response }
      return true
    })
    const bridge = create_draft_reference_bridge({ snapshot: () => current, rewrite, apply, on_error: vi.fn() })
    const pending = bridge.request()
    current = { ... current, markdown: 'typed' }
    await bridge.request()
    expect(rewrite).toHaveBeenCalledTimes(1)
    resolve(response)
    await pending
    expect(rewrite).toHaveBeenCalledTimes(2)
    expect(apply).toHaveBeenCalledTimes(1)
    await bridge.request()
    expect(rewrite).toHaveBeenCalledTimes(2)
  })

  it('preserves unknown baselines and retries only for a newer server version', async () => {
    let current = { ... initial, base_namespace_revision: null }
    const rewrite = vi.fn(async () => ({ ... response, base_namespace_revision: null, baseline_unavailable: { namespace: true, title: false } }))
    const apply = vi.fn((_snapshot, result) => {
      current = { ... current, ... result }
      return true
    })
    const bridge = create_draft_reference_bridge({ snapshot: () => current, rewrite, apply, on_error: vi.fn() })
    await bridge.request()
    current.markdown = 'typing'
    await bridge.request()
    expect(current.base_namespace_revision).toBeNull()
    expect(rewrite).toHaveBeenCalledTimes(1)
    current.namespace_revision = 4
    await bridge.request()
    expect(rewrite).toHaveBeenCalledTimes(2)
  })

  it('discards a stale response even when typing then undo restored the same text', async () => {
    let current = { ... initial }
    let resolve!: (value: ContentReferenceRewriteResult) => void
    const rewrite = vi.fn().mockImplementationOnce(() => new Promise((done) => {
      resolve = done
    })).mockResolvedValue(response)
    const apply = vi.fn(() => true)
    const bridge = create_draft_reference_bridge({ snapshot: () => current, rewrite, apply, on_error: vi.fn() })
    const pending = bridge.request()
    current = { ... current, local_revision: 2 }
    resolve(response)
    await pending
    expect(rewrite).toHaveBeenCalledTimes(2)
    expect(apply).toHaveBeenCalledTimes(1)
  })

  it.each(['save', 'identity', 'stop'])('never applies an old response after %s', async (mode) => {
    let current = { ... initial }
    let resolve!: (value: ContentReferenceRewriteResult) => void
    const rewrite = vi.fn(() => new Promise<ContentReferenceRewriteResult>((done) => {
      resolve = done
    }))
    const apply = vi.fn(() => true)
    const bridge = create_draft_reference_bridge({ snapshot: () => current, rewrite, apply, on_error: vi.fn() })
    const pending = bridge.request()
    if (mode === 'save') {
      current.saving = true
    }
    else if (mode === 'identity') {
      current = { ... current, viewer_key: '2', saving: true }
      bridge.invalidate()
    }
    else {
      bridge.stop()
    }
    resolve(response)
    await pending
    expect(apply).not.toHaveBeenCalled()
  })
})
