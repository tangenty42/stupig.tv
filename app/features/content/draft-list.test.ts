import type { ContentDraftSummary } from '@shared/types/content-draft'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { computed, effectScope, isRef, onScopeDispose, ref, watch } from 'vue'
import { useSyncedData } from '~/composables/useSyncedData'
import { useSyncedState } from '~/composables/useSyncedState'
import { useContentDraftList } from './draft-list'

interface DraftListPayload { items: ContentDraftSummary[], channel: string }

function snapshot(title?: string): DraftListPayload {
  return { items: title ? [{ id: title, story_id: null, title, updated_at: '2026-11-23T00:00:00Z' }] : [], channel: 'content_drafts:all' }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

const list_drafts = vi.fn<() => Promise<DraftListPayload>>()
const toast = vi.fn()
const viewer = ref({ id: 1, is_admin: true, permissions: [] })
let scope: ReturnType<typeof effectScope>
let app: { isHydrating: boolean, hook: ReturnType<typeof vi.fn> }
let hooks: Map<string, () => void>

beforeEach(() => {
  scope = effectScope()
  hooks = new Map()
  app = { isHydrating: false, hook: vi.fn((name: string, callback: () => void) => {
    hooks.set(name, callback)
    return () => hooks.delete(name)
  }) }
  list_drafts.mockReset()
  toast.mockReset()
  viewer.value = { id: 1, is_admin: true, permissions: [] }
  for (const [name, value] of Object.entries({ computed, effectScope, isRef, ref, watch, useSyncedData, useSyncedState }))
    vi.stubGlobal(name, value)
  vi.stubGlobal('onUnmounted', onScopeDispose)
  vi.stubGlobal('useNuxtApp', () => app)
  vi.stubGlobal('useMyToast', () => ({ error: toast }))
  vi.stubGlobal('get_error_status', (error: Error & { statusCode?: number }) => error.statusCode)
  vi.stubGlobal('useApi', () => ({ content: { list_drafts } }))
  vi.stubGlobal('useAuth', () => ({ user: viewer }))
  vi.stubGlobal('useDataSync', () => ({ subscribe: () => () => {} }))
  vi.stubGlobal('useReactiveDateNow', () => ref(0))
})

afterEach(() => {
  scope.stop()
  vi.unstubAllGlobals()
})

function setup() {
  return scope.run(() => useContentDraftList())!
}

it('reports initial failure and clears it when retry successfully returns an empty list', async () => {
  const failure = new Error('offline')
  list_drafts.mockRejectedValueOnce(failure).mockResolvedValueOnce(snapshot())
  const model = setup()
  await model.ready
  expect(model.error.value).toBe(failure)
  expect(model.data.value).toBeNull()
  expect(model.loading.value).toBe(false)
  expect(toast).toHaveBeenCalledExactlyOnceWith('草稿列表加载失败，请重试')
  await model.refresh()
  expect(model.data.value?.items).toEqual([])
  expect(model.error.value).toBeNull()
  expect(list_drafts.mock.calls).toEqual([[], []])
})

it('retains loaded rows during a failed background refresh and clears the error on an empty success', async () => {
  const refreshing = deferred<DraftListPayload>()
  const original = snapshot('draft')
  list_drafts.mockResolvedValueOnce(original).mockReturnValueOnce(refreshing.promise).mockResolvedValueOnce(snapshot())
  const model = setup()
  await model.ready
  const pending = model.refresh()
  await Promise.resolve()
  expect(model.loading.value).toBe(true)
  expect(model.data.value).toEqual(original)
  refreshing.reject(new Error('refresh failed'))
  await pending
  expect(model.data.value).toEqual(original)
  expect(model.error.value).toBeInstanceOf(Error)
  expect(toast).toHaveBeenCalledExactlyOnceWith('草稿列表更新失败')
  await model.refresh()
  expect(model.data.value?.items).toEqual([])
  expect(model.error.value).toBeNull()
})

it('clears errors on viewer changes and ignores an obsolete viewer’s success', async () => {
  const old_viewer = deferred<DraftListPayload>()
  const current_viewer = deferred<DraftListPayload>()
  list_drafts.mockRejectedValueOnce(new Error('initial failure')).mockReturnValueOnce(old_viewer.promise).mockReturnValueOnce(current_viewer.promise).mockResolvedValueOnce(snapshot())
  const model = setup()
  await model.ready
  viewer.value = { id: 2, is_admin: true, permissions: [] }
  expect(model.error.value).toBeNull()
  expect(model.data.value).toBeNull()
  viewer.value = { id: 3, is_admin: true, permissions: [] }
  current_viewer.reject(new Error('current request failed'))
  await vi.waitFor(() => expect(model.error.value).toBeInstanceOf(Error))
  old_viewer.resolve(snapshot('wrong viewer'))
  await Promise.resolve()
  expect(model.data.value).toBeNull()
  await model.refresh()
  expect(model.error.value).toBeNull()
  expect(model.data.value?.items).toEqual([])
  expect(list_drafts).toHaveBeenCalledTimes(4)
})

it('does not apply an old request failure after the current viewer’s request succeeds', async () => {
  const old = deferred<DraftListPayload>()
  list_drafts.mockReturnValueOnce(old.promise).mockResolvedValueOnce(snapshot('new list'))
  const model = setup()
  viewer.value = { id: 2, is_admin: true, permissions: [] }
  await vi.waitFor(() => expect(model.data.value?.items[0]?.title).toBe('new list'))
  old.reject(new Error('old failure'))
  await model.ready
  expect(model.error.value).toBeNull()
  expect(model.data.value?.items[0]?.title).toBe('new list')
})

it('leaves a settled missing payload distinguishable from a successful empty list when 401 is suppressed', async () => {
  list_drafts.mockRejectedValueOnce(Object.assign(new Error('unauthorized'), { statusCode: 401 }))
  const model = setup()
  await model.ready
  expect(model.loading.value).toBe(false)
  expect(model.error.value).toBeNull()
  expect(model.data.value).toBeNull()
  expect(toast).not.toHaveBeenCalled()
})

it.each(['success', 'failure'])('stages the initial %s until hydration commits', async (outcome) => {
  app.isHydrating = true
  list_drafts.mockImplementationOnce(() => outcome === 'success' ? Promise.resolve(snapshot()) : Promise.reject(new Error('offline')))
  const model = setup()
  await model.ready
  await Promise.resolve()
  expect(model.loading.value).toBe(true)
  expect(model.data.value).toBeNull()
  expect(model.error.value).toBeNull()
  app.isHydrating = false
  hooks.get('app:suspense:resolve')!()
  expect(model.loading.value).toBe(false)
  if (outcome === 'success')
    expect(model.data.value?.items).toEqual([])
  else
    expect(model.error.value).toBeInstanceOf(Error)
})
