import type { ContentAttachmentWorkspace } from '@shared/types/content'
import type { Ref } from 'vue'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { computed, effectScope, isRef, nextTick, onScopeDispose, ref, watch } from 'vue'
import { get_error_status, useApi } from '~/composables/useApi'
import { useSyncedData } from '~/composables/useSyncedData'
import { useSyncedState } from '~/composables/useSyncedState'
import { createAttachmentWorkspace } from './workspace'

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
  vi.stubGlobal('useReactiveDateNow', () => ref(0))
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

function open(story_id = 7) {
  const scope = effectScope()
  scopes.push(scope)
  return { workspace: scope.run(() => createAttachmentWorkspace(story_id))!, close: () => scope.stop() }
}

it('distinguishes initial loading and failure, then retries into a confirmed empty workspace', async () => {
  let reject!: (error: unknown) => void
  fetcher.mockReturnValueOnce(new Promise((_resolve, no) => {
    reject = no
  }))
  const { workspace } = open()
  expect(workspace.loading.value).toBe(true)
  expect(workspace.error.value).toBeNull()
  expect(workspace.data.value).toBeNull()
  reject(new Error('暂时无法连接附件服务'))
  await workspace.ready
  expect(workspace.loading.value).toBe(false)
  expect(workspace.error.value).toBe('暂时无法连接附件服务')
  expect(workspace.data.value).toBeNull()
  expect(toast).toHaveBeenCalledExactlyOnceWith('附件列表加载失败，请重试')

  const empty = { ... snapshot, attachments: [], folders: [] }
  fetcher.mockRejectedValueOnce(new Error('暂时无法连接附件服务'))
  await workspace.refresh()
  expect(toast).toHaveBeenCalledTimes(2)
  expect(toast).toHaveBeenLastCalledWith('附件列表加载失败，请重试')

  fetcher.mockResolvedValueOnce(empty)
  const retry = workspace.refresh()
  await nextTick()
  await retry
  expect(workspace.data.value).toEqual(empty)
  expect(workspace.error.value).toBeNull()
  expect(workspace.loading.value).toBe(false)
})

it('shares failures and keeps loaded data while refreshing, without duplicate refresh toasts', async () => {
  const one = open()
  await one.workspace.ready
  const two = open()
  await two.workspace.ready
  let reject!: (error: unknown) => void
  fetcher.mockReturnValueOnce(new Promise((_resolve, no) => {
    reject = no
  }))
  const refresh = one.workspace.refresh()
  await nextTick()
  expect(one.workspace.loading.value).toBe(true)
  expect(two.workspace.data.value).toEqual(snapshot)
  const failure = new Error('附件服务暂时不可用')
  reject(failure)
  await refresh
  expect(one.workspace.data.value).toEqual(snapshot)
  expect(two.workspace.error.value).toBe('附件服务暂时不可用')
  expect(toast).toHaveBeenCalledExactlyOnceWith('附件列表更新失败')

  fetcher.mockRejectedValueOnce(new Error('仍然无法连接附件服务'))
  await listeners.get('content_attachments:7')!()
  expect(toast).toHaveBeenCalledTimes(1)
})

it('does not request an inactive workspace or treat it as a failed load', async () => {
  const { workspace } = open(0)
  await workspace.ready
  expect(workspace.active).toBe(false)
  expect(workspace.loading.value).toBe(false)
  expect(workspace.error.value).toBeNull()
  expect(fetcher).not.toHaveBeenCalled()
})

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
  expect(workspace.error.value).toBe(status === 401 ? null : 'request failed')
  if (status !== 401)
    expect(toast).toHaveBeenCalledWith('附件列表更新失败')
})

it('stages a missing response until hydration resolves', async () => {
  app.isHydrating = true
  states.set('content_attachment_workspace:7', ref(snapshot))
  fetcher.mockRejectedValue({ data: { httpStatus: 404 } })
  const { workspace } = open()
  await workspace.ready
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(workspace.data.value).toEqual(snapshot)
  expect(workspace.error.value).toBeNull()
  app.isHydrating = false
  hooks.get('app:suspense:resolve')!()
  expect(workspace.data.value).toBeNull()
  expect(workspace.error.value).toBe('附件列表不存在或已被删除')
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
