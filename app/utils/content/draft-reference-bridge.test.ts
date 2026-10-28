import type { ContentReferenceRewriteResult } from '@shared/types/content-reference'
import type { DraftReferenceSnapshot } from './draft-reference-bridge'
import { describe, expect, it, vi } from 'vitest'
import { create_draft_reference_bridge } from './draft-reference-bridge'

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

  it.each([null, 0])('does not interrupt typing when history is unavailable for baseline %s', async (baseline) => {
    let current = { ... initial, base_namespace_revision: baseline }
    const rewrite = vi.fn(async () => ({ ... response, base_namespace_revision: baseline, baseline_unavailable: { namespace: true, title: false } }))
    const apply = vi.fn((_snapshot, result) => {
      current = { ... current, ... result }
      return true
    })
    const bridge = create_draft_reference_bridge({ snapshot: () => current, rewrite, apply, on_error: vi.fn() })
    await bridge.request()
    current.markdown = 'typing'
    await bridge.request()
    expect(current.base_namespace_revision).toBe(baseline)
    expect(rewrite).toHaveBeenCalledTimes(1)
    current.namespace_revision = 4
    await bridge.request()
    expect(rewrite).toHaveBeenCalledTimes(2)
  })

  it('retries a failed rewrite without requiring another change', async () => {
    vi.useFakeTimers()
    try {
      const rewrite = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(response)
      const apply = vi.fn(() => true)
      const bridge = create_draft_reference_bridge({ snapshot: () => initial, rewrite, apply, on_error: vi.fn() })
      await bridge.request()
      await vi.advanceTimersByTimeAsync(3000)
      expect(rewrite).toHaveBeenCalledTimes(2)
      expect(apply).toHaveBeenCalledOnce()
      bridge.stop()
    }
    finally {
      vi.useRealTimers()
    }
  })

  it('forces a server replay after invalidation even when cached versions match', async () => {
    const current = { ... initial, base_namespace_revision: 2, base_title_revision: 3 }
    const rewrite = vi.fn().mockResolvedValue(response)
    const bridge = create_draft_reference_bridge({ snapshot: () => current, rewrite, apply: () => true, on_error: vi.fn() })
    await bridge.request()
    expect(rewrite).not.toHaveBeenCalled()
    bridge.invalidate(true)
    await bridge.request()
    expect(rewrite).toHaveBeenCalledOnce()
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
