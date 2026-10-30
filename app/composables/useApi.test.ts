import type { ContentDraftSnapshot, DraftCommand, DraftResult } from '@shared/types/content-draft'
import type { ContentReferenceRewriteResult } from '@shared/types/content-reference'
import { settings } from '@shared/settings'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { computed, ref, shallowRef, watch } from 'vue'
import { useContentDraftStore } from '~/stores/contentDraft'
import { useApi } from './useApi'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((yes) => {
    resolve = yes
  })
  return { promise, resolve }
}

const stores: ReturnType<typeof useContentDraftStore>[] = []

beforeEach(() => {
  setActivePinia(createPinia())
  vi.useFakeTimers()
  for (const [name, value] of Object.entries({ computed, ref, shallowRef, watch }))
    vi.stubGlobal(name, value)
})

afterEach(() => {
  for (const store of stores.splice(0)) store.clear()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

function transport(content: object) {
  vi.stubGlobal('useTrpcClient', () => ({ client: { content }, call: <T>(request: Promise<T>) => request, upload: vi.fn() }))
  return useApi().content
}

it('times out and aborts reference replay even when the transport does not settle', async () => {
  const response = deferred<ContentReferenceRewriteResult>()
  const mutate = vi.fn((_input: unknown, _options: { signal: AbortSignal }) => response.promise)
  const content = transport({ rewriteDraftReferences: { mutate } })
  const input = { markdown: 'local input', base_namespace_revision: 0, base_title_revision: 0 }
  const result = content.rewrite_draft_references(7, input)
  const failure = expect(result).rejects.toThrow('连接超时，已暂停编辑')
  expect(mutate).toHaveBeenCalledWith({ id: 7, ... input }, { signal: expect.any(AbortSignal) })
  const signal = mutate.mock.calls[0]![1].signal
  await vi.advanceTimersByTimeAsync(settings.app.content.draft.requestTimeoutMs - 1)
  expect(signal.aborted).toBe(false)
  await vi.advanceTimersByTimeAsync(1)
  await failure
  expect(signal.aborted).toBe(true)
})

it('recovers newer input and releases the lease after reference replay times out, ignoring its late reply', async () => {
  let snapshot: ContentDraftSnapshot = { id: 'a'.repeat(32), story_id: 7, markdown: 'main', draft_revision: 1,
    namespace_revision: 0, title_revision: 0, published_main_revision: 1, unpublished_changes: false,
    lease_epoch: 0, occupied: false, owned: false, lease_remaining_ms: 23000, updated_at: '2026-10-30T00:00:00Z', channel: 'content_draft:opaque' }
  const response = deferred<DraftResult>()
  const replay = deferred<ContentReferenceRewriteResult>()
  const rewrite = vi.fn((_input: unknown, _options: { signal: AbortSignal }) => replay.promise)
  const command = vi.fn(async (input: DraftCommand): Promise<DraftResult> => {
    snapshot = { ... snapshot, ... (input.markdown === undefined ? {} : { markdown: input.markdown, draft_revision: snapshot.draft_revision + 1 }),
      ... (input.kind === 'release' ? { owned: false, occupied: false } : {}) }
    return { snapshot, receipt: { kind: input.kind, seq: input.seq, ok: true } }
  })
  command.mockReturnValueOnce(response.promise)
  const content = transport({
    getDraft: { mutate: async () => ({ snapshot }) },
    acquireDraft: { mutate: async () => {
      snapshot = { ... snapshot, owned: true, occupied: true, lease_epoch: 1 }
      return { snapshot }
    } },
    commandDraft: { mutate: command }, rewriteDraftReferences: { mutate: rewrite },
  })
  const store = useContentDraftStore(snapshot.id)
  stores.push(store)
  store.configure({ get: content.get_draft, acquire: content.acquire_draft, command: content.command_draft, rewrite: content.rewrite_draft_references }, () => true)
  store.set_cycle_trigger(async () => {})
  await store.open({ id: snapshot.id })
  store.set_visible(true)
  await store.cycle()
  store.markdown = '[](att://old)'
  const saving = store.cycle()
  const failure = expect(saving).rejects.toThrow('连接超时，已暂停编辑')
  store.markdown += ' newer input'
  snapshot = { ... snapshot, markdown: '[](att://new)', namespace_revision: 1, draft_revision: 2 }
  response.resolve({ snapshot, receipt: { kind: 'sync', seq: 1, ok: true } })
  await vi.waitFor(() => expect(rewrite).toHaveBeenCalledOnce())
  expect(store.reference_pending).toBe(true)
  await vi.advanceTimersByTimeAsync(settings.app.content.draft.requestTimeoutMs)
  await failure
  expect(rewrite.mock.calls[0]![1].signal.aborted).toBe(true)
  expect(store.reference_pending).toBe(false)
  expect(store.request_pending).toBe(false)
  expect(store.phase).toBe('uncertain')
  expect(store.writable).toBe(false)
  expect(store.markdown).toBe('[](att://old) newer input')
  const rewritten: ContentReferenceRewriteResult = { markdown: '[](att://new) newer input', changes: [], diagnostics: [],
    namespace_revision: 1, title_revision: 0, base_namespace_revision: 1, base_title_revision: 0, baseline_unavailable: { namespace: false, title: false } }
  rewrite.mockResolvedValueOnce(rewritten)
  await store.cycle()
  expect(store.writable).toBe(true)
  expect(store.dirty).toBe(false)
  expect(command.mock.calls[1]![0]).toMatchObject({ kind: 'sync', seq: 2, markdown: rewritten.markdown, base_namespace_revision: 1 })
  replay.resolve({ ... rewritten, markdown: 'late stale reply' })
  await vi.advanceTimersByTimeAsync(0)
  expect(store.markdown).toBe(rewritten.markdown)
  store.set_visible(false)
  await store.cycle()
  expect(command.mock.calls.at(- 1)![0]).toMatchObject({ kind: 'release', seq: 3 })
  expect(store.cloud?.owned).toBe(false)
})
