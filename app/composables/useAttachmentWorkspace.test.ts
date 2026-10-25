import type { ContentAttachmentWorkspace } from '@shared/types/content'
import type { Ref } from 'vue'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { computed, effectScope, isRef, nextTick, onScopeDispose, ref, watch } from 'vue'
import { get_error_status, useApi } from './useApi'
import { createAttachmentWorkspace } from './useAttachmentWorkspace'
import { useSyncedData } from './useSyncedData'
import { useSyncedState } from './useSyncedState'

const snapshot: ContentAttachmentWorkspace = { attachments: [], folders: ['photos'], namespace_revision: 3, viewer_key: '1:true' }
const fetcher = vi.fn<() => Promise<ContentAttachmentWorkspace>>()
const toast = vi.fn()
const listeners = new Map<string, () => Promise<void>>()
const states = new Map<string, Ref<unknown>>()
const hooks = new Map<string, () => void>()
const scopes: ReturnType<typeof effectScope>[] = []
let app: { isHydrating: boolean, hook: (name: string, callback: () => void) => () => void }

beforeEach(() => {
  states.clear()
  listeners.clear()
  hooks.clear()
  toast.mockReset()
  fetcher.mockReset().mockResolvedValue(snapshot)
  app = { isHydrating: false, hook: (name, callback) => {
    hooks.set(name, callback)
    return () => {
      hooks.delete(name)
    }
  } }
  for (const [name, value] of Object.entries({ computed, effectScope, isRef, ref, watch, useApi, useSyncedData, useSyncedState, get_error_status, onUnmounted: onScopeDispose }))
    vi.stubGlobal(name, value)
  vi.stubGlobal('useNuxtApp', () => app)
  vi.stubGlobal('useMyToast', () => ({ error: toast }))
  vi.stubGlobal('useState', (key: string, init: () => unknown) => {
    if (! states.has(key))
      states.set(key, ref(init()))
    return states.get(key)
  })
  vi.stubGlobal('useTrpcClient', () => ({ call: (request: Promise<unknown>) => request, client: { content: { getAttachmentWorkspace: { query: fetcher } } } }))
  vi.stubGlobal('useDataSync', () => ({ subscribe: (key: string, callback: () => Promise<void>) => {
    listeners.set(key, callback)
    return () => listeners.delete(key)
  } }))
})

afterEach(() => {
  scopes.splice(0).forEach(scope => scope.stop())
  vi.unstubAllGlobals()
})

function open() {
  const scope = effectScope()
  scopes.push(scope)
  return { workspace: scope.run(() => createAttachmentWorkspace(7))!, close: () => scope.stop() }
}

it('clears every workspace consumer and cached remount after a confirmed deletion', async () => {
  const one = open()
  await one.workspace.ready
  const two = open()
  await two.workspace.ready
  expect(one.workspace.data.value?.folders).toEqual(['photos'])
  fetcher.mockRejectedValue(Object.assign(new Error('gone'), { status: 404 }))
  await listeners.get('content_attachments:7')!()
  expect(one.workspace.data.value).toBeNull()
  expect(two.workspace.data.value).toBeNull()
  const joined = open()
  await joined.workspace.ready
  expect(joined.workspace.data.value).toBeNull()
  expect(fetcher).toHaveBeenCalledTimes(2)
  one.close()
  two.close()
  joined.close()
  const remounted = open()
  await remounted.workspace.ready
  expect(remounted.workspace.data.value).toBeNull()
  expect(toast).not.toHaveBeenCalled()
})

it.each([401, 403, 409, 500, 503])('retains the last workspace for a non-missing %i failure', async (status) => {
  const { workspace } = open()
  await workspace.ready
  const error = Object.assign(new Error('request failed'), { status })
  fetcher.mockRejectedValue(error)
  await listeners.get('content_attachments:7')!()
  expect(workspace.data.value).toEqual(snapshot)
  if (status !== 401)
    expect(toast).toHaveBeenCalledWith(error)
})

it('stages a missing response until hydration resolves', async () => {
  app.isHydrating = true
  states.set('content_attachment_workspace:7', ref(snapshot))
  fetcher.mockRejectedValue({ data: { httpStatus: 404 } })
  const { workspace } = open()
  await workspace.ready
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(workspace.data.value).toEqual(snapshot)
  app.isHydrating = false
  hooks.get('app:suspense:resolve')!()
  expect(workspace.data.value).toBeNull()
})

it('discards a superseded 404 instead of erasing a newer workspace', async () => {
  const { workspace } = open()
  await workspace.ready
  let reject!: (error: unknown) => void
  fetcher.mockReturnValueOnce(new Promise((_resolve, no) => {
    reject = no
  }))
  const pending = listeners.get('content_attachments:7')!()
  const next = listeners.get('content_attachments:7')!()
  fetcher.mockResolvedValue({ ... snapshot, namespace_revision: 4, folders: ['new'] })
  reject({ statusCode: 404 })
  await Promise.all([pending, next])
  await nextTick()
  expect(workspace.data.value?.folders).toEqual(['new'])
})
