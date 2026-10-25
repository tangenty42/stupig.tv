import type { ContentUploadSession } from '@shared/types/content-upload'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { computed, effectScope, isRef, onScopeDispose, reactive, ref, watch } from 'vue'
import { useContentUploadsStore } from '~/stores/contentUploads'
import { get_error_status } from './useApi'
import { useContentUploadSync } from './useContentUploadSync'
import { useSyncedData } from './useSyncedData'
import { useSyncedState } from './useSyncedState'

const state = vi.hoisted(() => ({ list: vi.fn(), toast: vi.fn() }))
vi.mock('~/utils/content/browser-upload', () => ({ create_browser_upload: vi.fn(), upload_file_sha256: vi.fn() }))
const user = ref({ id: 7, is_admin: true })
const resources = new Map<string, ReturnType<typeof ref>>()
const listeners = new Map<string, () => Promise<void>>()
let pinia = createPinia()
const scopes: ReturnType<typeof effectScope>[] = []
const session = { id: 'a'.repeat(32), status: 'uploading', path: 'a.txt' } as ContentUploadSession
for (const [name, value] of Object.entries({ computed, effectScope, isRef, reactive, ref, watch, get_error_status, useSyncedData, useSyncedState }))
  vi.stubGlobal(name, value)
vi.stubGlobal('useCookie', () => user)
vi.stubGlobal('useState', (key: string, init: () => unknown) => {
  if (! resources.has(key))
    resources.set(key, ref(init()))
  return resources.get(key)
})
vi.stubGlobal('useApi', () => ({ content: { list_upload_sessions: state.list } }))
vi.stubGlobal('useMyToast', () => ({ error: state.toast }))
vi.stubGlobal('onUnmounted', onScopeDispose)
vi.stubGlobal('useDataSync', () => ({ subscribe: (resource: string, callback: () => Promise<void>) => {
  listeners.set(resource, callback)
  return () => listeners.delete(resource)
} }))

beforeEach(() => {
  vi.resetAllMocks()
  resources.clear()
  listeners.clear()
  user.value = { id: 7, is_admin: true }
  pinia = createPinia()
  setActivePinia(pinia)
  const app = { isHydrating: false, hook: vi.fn(), vueApp: { onUnmount: vi.fn() } }
  vi.stubGlobal('useNuxtApp', () => app)
  state.list.mockResolvedValue({ enabled: true, sessions: [session] })
})
afterEach(() => {
  for (const scope of scopes.splice(0))
    scope.stop()
  disposePinia(pinia)
})
function mount() {
  const scope = effectScope()
  scopes.push(scope)
  return scope.run(() => useContentUploadSync(24))!
}

it('shares a single list subscription and drops old identity responses', async () => {
  let finish!: (value: { enabled: boolean, sessions: ContentUploadSession[] }) => void
  state.list.mockImplementationOnce(() => new Promise((resolve) => {
    finish = resolve
  }))
  const old = mount()
  const store = useContentUploadsStore(24)
  const next = { ... session, id: 'b'.repeat(32) }
  state.list.mockResolvedValue({ enabled: true, sessions: [next] })
  user.value = { id: 8, is_admin: true }
  await vi.waitFor(() => expect(state.list).toHaveBeenCalledTimes(2))
  finish({ enabled: true, sessions: [{ ... session, path: 'private-old-user.txt' }] })
  await old
  await mount()
  expect(state.list).toHaveBeenCalledTimes(2)
  expect(store.sessions).toEqual([next])
  expect(listeners.size).toBe(1)
})

it('clears the resource on authorization loss without a fetch loop or a remote cancellation', async () => {
  await mount()
  const store = useContentUploadsStore(24)
  expect(store.sessions).toHaveLength(1)
  state.list.mockRejectedValueOnce(Object.assign(new Error('权限已撤销'), { status: 403 }))
  await listeners.get('content_uploads:24')!()
  expect(store.sessions).toEqual([])
  expect(store.ready).toBe(false)
  expect(state.list).toHaveBeenCalledTimes(2)
  expect(state.toast).toHaveBeenCalledOnce()
})

it('updates scope-wide occupancy through the existing upload subscription without adding foreign upload rows', async () => {
  const reservation = { id: 'foreign', path: 'docs/new.txt', parent_id: 2, source_id: 3 }
  state.list.mockResolvedValue({ enabled: true, sessions: [], reservations: [reservation] })
  await mount()
  const store = useContentUploadsStore(24)
  expect(store.sessions).toEqual([])
  expect(store.reservations).toEqual([reservation])
  state.list.mockResolvedValueOnce({ enabled: true, sessions: [], reservations: [] })
  await listeners.get('content_uploads:24')!()
  expect(store.reservations).toEqual([])
  expect(listeners.size).toBe(1)
})
