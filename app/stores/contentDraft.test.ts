import type { ContentDraftSnapshot, DraftCommand, DraftResult } from '@shared/types/content-draft'
import { settings } from '@shared/settings'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computed, ref, shallowRef, watch } from 'vue'
import { useContentDraftStore } from './contentDraft'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
function head(overrides: Partial<ContentDraftSnapshot> = {}): ContentDraftSnapshot {
  return { id: 'a'.repeat(32), story_id: 7, markdown: 'main', draft_revision: 1, namespace_revision: 0, title_revision: 0,
    published_main_revision: 1, unpublished_changes: false, lease_epoch: 0, occupied: false, owned: false, lease_remaining_ms: 23000,
    updated_at: '2026-10-30T00:00:00Z', channel: 'content_draft:opaque', ... overrides }
}
const stores: ReturnType<typeof useContentDraftStore>[] = []
async function fixture(overrides: Partial<ContentDraftSnapshot> = {}) {
  let snapshot = head(overrides)
  const get = vi.fn(async () => ({ snapshot: { ... snapshot } }))
  const acquire = vi.fn(async (_input: { id: string, expected_epoch: number, page_id: string, token: string }) => {
    snapshot = { ... snapshot, owned: true, occupied: true, lease_epoch: 1 }
    return { snapshot: { ... snapshot } }
  })
  const command = vi.fn(async (input: DraftCommand): Promise<DraftResult> => {
    snapshot = { ... snapshot, ... (input.markdown === undefined ? {} : { markdown: input.markdown, draft_revision: snapshot.draft_revision + 1, unpublished_changes: true }),
      ... (input.kind === 'release' ? { owned: false, occupied: false } : {}), ... (input.kind === 'publish' ? { unpublished_changes: false } : {}) }
    return { snapshot: { ... snapshot }, receipt: { seq: input.seq, kind: input.kind, ok: true } }
  })
  const rewrite = vi.fn(async (_id: number, input: { markdown: string }) => ({ markdown: input.markdown, changes: [], diagnostics: [], namespace_revision: snapshot.namespace_revision, title_revision: snapshot.title_revision,
    base_namespace_revision: snapshot.namespace_revision, base_title_revision: snapshot.title_revision, baseline_unavailable: { namespace: false, title: false } }))
  const store = useContentDraftStore('a'.repeat(32))
  stores.push(store)
  const api = { get, acquire, command, rewrite }
  const owner = store.configure(api, () => true)
  store.set_cycle_trigger(async () => {})
  await store.open({ id: snapshot.id })
  store.set_visible(true)
  await store.cycle()
  return { store, api, owner, head: () => snapshot, change: (value: Partial<ContentDraftSnapshot>) => {
    snapshot = { ... snapshot, ... value }
  } }
}
beforeEach(() => {
  setActivePinia(createPinia())
  vi.useFakeTimers()
  for (const [name, value] of Object.entries({ ref, computed, watch, shallowRef })) {
    vi.stubGlobal(name, value)
  }
  vi.stubGlobal('localStorage', {
    getItem: vi.fn(() => {
      throw new Error('Must not read local drafts')
    }),
    setItem: vi.fn(() => {
      throw new Error('Must not persist drafts')
    }),
    removeItem: vi.fn(() => {
      throw new Error('User owns legacy cleanup')
    }),
  })
})
afterEach(() => {
  for (const store of stores.splice(0)) store.clear()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('shared cloud draft session', () => {
  it('recovers a lost acquire response using the same page, token and expected epoch', async () => {
    const f = await fixture()
    f.store.configure(f.api, () => true)
    f.change({ owned: false, occupied: false, lease_epoch: 1 })
    await f.store.open({ id: f.head().id })
    f.api.acquire.mockImplementationOnce(async () => {
      f.change({ occupied: true, lease_epoch: 2 })
      throw new Error('Acquire response lost')
    })
    f.store.set_visible(true)
    await expect(f.store.cycle()).rejects.toThrow('Acquire response lost')
    const first = f.api.acquire.mock.calls.at(- 1)
    f.api.acquire.mockImplementationOnce(async () => ({ snapshot: head({ owned: true, occupied: true, lease_epoch: 2 }) }))
    await f.store.cycle()
    expect(f.api.acquire.mock.calls.at(- 1)).toEqual(first)
    expect(f.store.writable).toBe(true)
  })
  it('keeps trailing input while continuous typing is throttled and refresh notifications cannot bypass N', async () => {
    const f = await fixture()
    f.store.set_cycle_trigger(() => f.store.cycle())
    for (let index = 0; index < 12; index ++) {
      f.store.markdown = `input${index}`
      await f.store.cycle()
      await vi.advanceTimersByTimeAsync(100)
    }
    expect(f.api.command.mock.calls.filter(([input]) => input.markdown !== undefined)).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(1000)
    expect(f.api.command.mock.calls.filter(([input]) => input.markdown !== undefined)).toHaveLength(3)
    expect(f.api.command.mock.calls.at(- 1)![0].markdown).toBe('input11')
  })
  it('starts read only, acquires a server lease, and never touches local persistence', async () => {
    const f = await fixture()
    expect(f.store.writable).toBe(true)
    expect(f.api.acquire).toHaveBeenCalledOnce()
    f.store.markdown = 'input'
    await f.store.cycle()
    expect(f.store.markdown).toBe('input')
    expect(localStorage.getItem).not.toHaveBeenCalled()
    expect(localStorage.setItem).not.toHaveBeenCalled()
    expect(localStorage.removeItem).not.toHaveBeenCalled()
  })
  it('keeps ordinary relative links and incomplete private tags verbatim during autosave', async () => {
    const f = await fixture()
    f.store.markdown = '[file](relative.pdf) <good>unfinished'
    await f.store.cycle()
    expect(f.api.command.mock.calls[0]![0].markdown).toBe('[file](relative.pdf) <good>unfinished')
  })
  it('only publishes after the latest input has been acknowledged', async () => {
    const f = await fixture()
    f.store.markdown = 'new text'
    await f.store.action('publish')
    expect(f.api.command.mock.calls.map(([input]) => input.kind)).toEqual(['sync', 'publish'])
    expect(f.api.command.mock.calls[1]![0]).toMatchObject({ expected_revision: 2, seq: 2 })
  })
  it.each([
    { story_id: 7, restored: 'published main' },
    { story_id: null, restored: 'new draft template' },
  ])('discards unsaved input on reset without uploading it again, story=$story_id', async ({ story_id, restored }) => {
    const f = await fixture({ story_id, markdown: 'cloud draft', unpublished_changes: true })
    f.store.set_cycle_trigger(() => f.store.cycle())
    f.store.markdown = 'discard this unsaved input'
    const response = deferred<DraftResult>()
    f.api.command.mockReturnValueOnce(response.promise)
    const resetting = f.store.action('reset', 1)
    expect(f.store.writable).toBe(false)
    expect(f.api.command.mock.calls[0]![0]).toMatchObject({ kind: 'reset', seq: 1, expected_revision: 1 })
    expect(f.api.command.mock.calls[0]![0].markdown).toBeUndefined()
    f.change({ markdown: restored, draft_revision: 2, namespace_revision: 3, title_revision: 4, unpublished_changes: false })
    response.resolve({ snapshot: f.head(), receipt: { kind: 'reset', seq: 1, ok: true } })
    expect(await resetting).toBe(true)
    expect(f.store.markdown).toBe(restored)
    expect(f.store.unconfirmed_changes).toBe(false)
    expect(f.store.unpublished_changes).toBe(false)
    expect(f.api.rewrite).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(settings.app.content.draft.saveThrottleMs)
    await f.store.cycle()
    expect(f.api.command).toHaveBeenCalledTimes(2)
    expect(f.api.command.mock.calls[1]![0]).toMatchObject({ kind: 'sync', seq: 2, base_namespace_revision: 3, base_title_revision: 4 })
    expect(f.api.command.mock.calls[1]![0].markdown).toBeUndefined()
  })
  it('retains local input when reset is rejected because the snapshot changed', async () => {
    const f = await fixture()
    f.store.markdown = 'keep this unsaved input'
    f.api.command.mockResolvedValueOnce({ snapshot: { ... f.head(), markdown: 'new cloud draft', draft_revision: 2 },
      receipt: { kind: 'reset', seq: 1, ok: false, error: 'snapshot_changed' } })
    expect(await f.store.action('reset', 1)).toBe(false)
    expect(f.store.markdown).toBe('keep this unsaved input')
    expect(f.store.dirty).toBe(true)
  })
  it('applies a successful reset receipt after retrying a lost response', async () => {
    const f = await fixture()
    f.store.markdown = 'discard after confirmation'
    f.api.command.mockRejectedValueOnce(new Error('Reset reply lost'))
    await expect(f.store.action('reset')).rejects.toThrow('Reset reply lost')
    expect(f.store.markdown).toBe('discard after confirmation')
    expect(f.store.writable).toBe(false)
    f.api.command.mockResolvedValueOnce({ snapshot: { ... f.head(), draft_revision: 2 }, receipt: { kind: 'reset', seq: 1, ok: true } })
    await f.store.cycle()
    expect(f.api.command.mock.calls[1]![0]).toEqual(f.api.command.mock.calls[0]![0])
    expect(f.store.markdown).toBe('main')
    expect(f.store.dirty).toBe(false)
    await f.store.cycle()
    expect(f.api.command.mock.calls[2]![0].markdown).toBeUndefined()
  })
  it('ignores a reset response from an earlier page session', async () => {
    const f = await fixture()
    f.store.markdown = 'old page input'
    const response = deferred<DraftResult>()
    f.api.command.mockReturnValueOnce(response.promise)
    const resetting = f.store.action('reset')
    f.store.configure(f.api, () => true)
    await f.store.open({ id: f.head().id })
    f.store.markdown = 'new page input'
    response.resolve({ snapshot: { ... f.head(), draft_revision: 2 }, receipt: { kind: 'reset', seq: 1, ok: true } })
    await resetting
    expect(f.store.markdown).toBe('new page input')
    expect(f.store.cloud?.draft_revision).toBe(1)
  })
  it('reports an action complete only from its matching successful receipt', async () => {
    const f = await fixture()
    f.api.command.mockResolvedValueOnce({ snapshot: head({ lease_epoch: 2, occupied: true }), receipt: { seq: 1, kind: 'publish', ok: false, error: 'lease_lost' } })
    expect(await f.store.action('publish')).toBe(false)
    expect(f.store.writable).toBe(false)
  })
  it('recognizes an absent target after a committed delete reply was lost', async () => {
    const f = await fixture()
    f.api.command.mockRejectedValueOnce(Object.assign(new Error('Draft no longer exists'), { status: 404 }))
    expect(await f.store.action('delete')).toBe(true)
    expect(f.store.cloud).toBeNull()
    expect(f.store.markdown).toBe('')
  })
  it('retains input typed after a save snapshot was sent', async () => {
    const f = await fixture()
    const response = deferred<DraftResult>()
    f.api.command.mockReturnValueOnce(response.promise)
    f.store.markdown = 'sent'
    const pending = f.store.cycle()
    f.store.markdown = 'sent and more'
    response.resolve({ snapshot: head({ owned: true, occupied: true, lease_epoch: 1, markdown: 'sent', draft_revision: 2 }), receipt: { kind: 'sync', seq: 1, ok: true } })
    await pending
    expect(f.store.markdown).toBe('sent and more')
    expect(f.store.dirty).toBe(true)
  })
  it('retries a lost response with the exact sequence and original payload before new text', async () => {
    const f = await fixture()
    f.api.command.mockRejectedValueOnce(new Error('Response lost'))
    f.store.markdown = 'first'
    await expect(f.store.cycle()).rejects.toThrow('Response lost')
    expect(f.store.writable).toBe(false)
    f.store.markdown = 'first plus newer input'
    await f.store.cycle()
    expect(f.api.command.mock.calls[1]![0]).toEqual(f.api.command.mock.calls[0]![0])
    expect(f.store.markdown).toBe('first plus newer input')
    await vi.advanceTimersByTimeAsync(settings.app.content.draft.saveThrottleMs)
    await f.store.cycle()
    expect(f.api.command.mock.calls[2]![0]).toMatchObject({ seq: 2, markdown: 'first plus newer input' })
  })
  it('blocks old callbacks when the same store is reopened', async () => {
    const f = await fixture()
    const response = deferred<DraftResult>()
    f.api.command.mockReturnValueOnce(response.promise)
    f.store.markdown = 'old input'
    const old = f.store.cycle()
    f.store.configure(f.api, () => true)
    response.resolve({ snapshot: head({ owned: true, markdown: 'old result' }), receipt: { seq: 1, kind: 'sync', ok: true } })
    await old
    expect(f.store.markdown).toBe('')
    expect(f.store.cloud).toBeNull()
    expect(f.store.owns(f.owner)).toBe(false)
  })
  it('moves unconfirmed input to a read only recovery area after takeover', async () => {
    const f = await fixture()
    f.store.markdown = 'unconfirmed'
    f.api.command.mockResolvedValueOnce({ snapshot: head({ markdown: 'other editor', lease_epoch: 2, occupied: true }), receipt: { seq: 1, kind: 'sync', ok: false, error: 'lease_lost' } })
    await f.store.cycle()
    expect(f.store.recovery).toBe('unconfirmed')
    expect(f.store.markdown).toBe('other editor')
    expect(f.store.writable).toBe(false)
    f.store.clear()
    expect(f.store.recovery).toBe('')
  })
  it('preserves a reverted input if editing rights are lost before its pending save resolves', async () => {
    const f = await fixture()
    const response = deferred<DraftResult>()
    f.api.command.mockReturnValueOnce(response.promise)
    f.store.markdown = 'sent'
    const saving = f.store.cycle()
    f.store.markdown = 'main'
    response.resolve({ snapshot: head({ markdown: 'other editor', lease_epoch: 2, occupied: true }), receipt: { seq: 1, kind: 'sync', ok: false, error: 'lease_lost' } })
    await saving
    expect(f.store.recovery).toBe('main')
    expect(f.store.markdown).toBe('other editor')
    expect(f.store.writable).toBe(false)
  })
  it('does not let a late upload insert after the same page acquires a new epoch', async () => {
    const f = await fixture()
    const may_insert = f.store.capture_write_permit()
    expect(may_insert()).toBe(true)
    f.api.command.mockResolvedValueOnce({ snapshot: head({ lease_epoch: 2, occupied: true }), receipt: { seq: 1, kind: 'sync', ok: false, error: 'lease_lost' } })
    await f.store.cycle()
    expect(may_insert()).toBe(false)
    f.change({ lease_epoch: 2, occupied: false, owned: false })
    f.api.acquire.mockResolvedValueOnce({ snapshot: head({ lease_epoch: 3, owned: true, occupied: true }) })
    await f.store.cycle()
    expect(f.store.can_write_now()).toBe(true)
    expect(may_insert()).toBe(false)
    expect(f.store.capture_write_permit()()).toBe(true)
  })
  it('does not overwrite review-required input or automatically retry the rejected text', async () => {
    const f = await fixture()
    f.store.markdown = 'needs review'
    f.api.command.mockResolvedValueOnce({ snapshot: head({ owned: true, occupied: true, lease_epoch: 1 }), receipt: { seq: 1, kind: 'sync', ok: false, error: 'reference_review_required', review_token: 'e'.repeat(64) } })
    await f.store.cycle()
    expect(f.store.markdown).toBe('needs review')
    expect(f.store.review?.text).toBe('needs review')
    await f.store.cycle()
    expect(f.api.command.mock.calls[1]![0].markdown).toBeUndefined()
  })
  it('lets a recovered lease confirm history review even when local input cannot be replayed', async () => {
    const f = await fixture()
    f.store.markdown = 'old in-flight input'
    f.api.command.mockRejectedValueOnce(new Error('Disconnected'))
    await expect(f.store.cycle()).rejects.toThrow('Disconnected')
    f.api.command.mockResolvedValueOnce({ snapshot: head({ owned: true, occupied: true, lease_epoch: 1, namespace_revision: 300 }), receipt: {
      seq: 1, kind: 'sync', ok: false, error: 'reference_review_required', review_token: 'e'.repeat(64),
    } })
    f.api.rewrite.mockResolvedValueOnce({ markdown: f.store.markdown, changes: [], diagnostics: [], namespace_revision: 300, title_revision: 0,
      base_namespace_revision: 0, base_title_revision: 0, baseline_unavailable: { namespace: true, title: false } })
    await f.store.cycle()
    expect(f.store.writable).toBe(true)
    expect(f.store.markdown).toBe('old in-flight input')
    expect(f.store.review).not.toBeNull()
    await f.store.confirm_review()
    expect(f.api.command.mock.calls.at(- 1)![0]).toMatchObject({ seq: 2, confirm_reference_history: 'e'.repeat(64) })
  })
  it('reuses a review only for the exact text and sends a new command sequence', async () => {
    const f = await fixture()
    f.store.markdown = 'needs review'
    f.api.command.mockResolvedValueOnce({ snapshot: head({ owned: true, occupied: true, lease_epoch: 1 }), receipt: { seq: 1, kind: 'sync', ok: false, error: 'reference_review_required', review_token: 'e'.repeat(64) } })
    await f.store.cycle()
    await f.store.confirm_review()
    expect(f.api.command.mock.calls[1]![0]).toMatchObject({ seq: 2, markdown: 'needs review', confirm_reference_history: 'e'.repeat(64) })
  })
  it('closes input before sending the final snapshot and release together', async () => {
    const f = await fixture()
    f.store.markdown = 'last input'
    f.store.set_visible(false)
    expect(f.store.writable).toBe(false)
    await f.store.cycle()
    expect(f.api.command.mock.calls.at(- 1)![0]).toMatchObject({ kind: 'release', markdown: 'last input' })
  })
  it('stops editing at the conservative deadline even with no network event', async () => {
    const f = await fixture()
    await vi.advanceTimersByTimeAsync(23000 - settings.app.content.draft.leaseMarginMs + 1)
    expect(f.store.check_writable()).toBe(false)
  })
  it('merges simultaneous refreshes into one request', async () => {
    const f = await fixture()
    const response = deferred<DraftResult>()
    f.api.command.mockReturnValueOnce(response.promise)
    const first = f.store.cycle()
    const second = f.store.cycle()
    expect(f.api.command).toHaveBeenCalledOnce()
    response.resolve({ snapshot: head({ owned: true, occupied: true, lease_epoch: 1 }), receipt: { seq: 1, kind: 'sync', ok: true } })
    await Promise.all([first, second])
  })
})
