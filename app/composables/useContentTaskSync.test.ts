import type { ContentTaskState } from '@shared/types/content'
import type { DataSyncEvent } from '@shared/types/sync'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computed, effectScope, isRef, reactive, ref, watch } from 'vue'
import { useContentTasksStore } from '~/stores/contentTasks'
import { useContentTaskSync } from './useContentTaskSync'
import { useSyncedData } from './useSyncedData'

const list_scope_tasks = vi.fn()
const listeners = new Map<string, Set<(event: DataSyncEvent) => unknown>>()
const cleanup: (() => void)[] = []

function task_state(id = 7): ContentTaskState {
  return {
    task: { id, scope_id: 42, kind: 'upload', status: 'paused', payload: { uploads: [{ path: 'a b.png', size: 100, mime_type: null }] }, actor_id: 1, client_id: null, error: null, heartbeat_at: null, created_at: '', updated_at: '' },
    items: [{ id: id * 10, task_id: id, path: '__pending_upload_0', action: 'upload', status: 'pending', bytes_done: 0, bytes_total: 100, staging_key: null, upload_id: null, part_size: null, result: { resolve: { kind: 'sanitize', from: 'a b.png', to: 'ab.png', reason: '和谐', entry_index: 0 } } }],
  }
}

async function emit_event(type: DataSyncEvent['type'], task_snapshot?: DataSyncEvent['task_snapshot']) {
  const event: DataSyncEvent = { id: 'event', type, resource: 'content_story_tasks:42', timestamp: 0, sync_all: type === 'sync', task_snapshot }
  await Promise.all([... (listeners.get(event.resource) ?? [])].map(listener => listener(event)))
}

beforeEach(() => {
  setActivePinia(createPinia())
  list_scope_tasks.mockReset().mockResolvedValue([task_state()])
  listeners.clear()
  cleanup.length = 0
  const app = { isHydrating: false, hook: vi.fn() }
  vi.stubGlobal('ref', ref)
  vi.stubGlobal('computed', computed)
  vi.stubGlobal('reactive', reactive)
  vi.stubGlobal('isRef', isRef)
  vi.stubGlobal('watch', watch)
  vi.stubGlobal('effectScope', effectScope)
  vi.stubGlobal('useApi', () => ({ content: { list_scope_tasks } }))
  vi.stubGlobal('useClientInstanceId', () => 'client')
  vi.stubGlobal('useNuxtApp', () => app)
  vi.stubGlobal('useMyToast', () => ({ error: vi.fn() }))
  vi.stubGlobal('onUnmounted', (callback: () => void) => cleanup.push(callback))
  vi.stubGlobal('onBeforeUnmount', (callback: () => void) => cleanup.push(callback))
  vi.stubGlobal('useSyncedData', useSyncedData)
  vi.stubGlobal('useDataSync', () => ({
    subscribe: (resource: string, listener: (event: DataSyncEvent) => unknown) => {
      const callbacks = listeners.get(resource) ?? new Set()
      callbacks.add(listener)
      listeners.set(resource, callbacks)
      return () => {
        callbacks.delete(listener)
        if (! callbacks.size)
          listeners.delete(resource)
      }
    },
  }))
})

afterEach(() => {
  cleanup.forEach(callback => callback())
  vi.unstubAllGlobals()
})

describe('content task sync wiring', () => {
  it('首次加载持久 paused 项，应用进度快照不拉取；集合刷新与重连补齐列表', async () => {
    await useContentTaskSync(42)
    const store = useContentTasksStore(42)
    expect(list_scope_tasks).toHaveBeenCalledExactlyOnceWith(42)
    expect(store.pending_rows[0]).toMatchObject({ task_status: 'paused', resolution: { from: 'a b.png', to: 'ab.png' } })

    await emit_event('task_progress', {
      task_id: 7, scope_id: 42, status: 'paused',
      items: [{ id: 70, path: 'a b.png', status: 'pending', bytes_done: 50, bytes_total: 100, resolution: { kind: 'sanitize', from: 'a b.png', to: 'ab.png', reason: '和谐', entry_index: 0 }, reason: null }],
    })
    expect(store.pending_rows[0]?.bytes_done).toBe(50)
    expect(list_scope_tasks).toHaveBeenCalledOnce()

    list_scope_tasks.mockResolvedValue([task_state(), task_state(8)])
    await emit_event('refresh')
    expect(store.tasks.map(entry => entry.task.id)).toEqual([7, 8])
    list_scope_tasks.mockResolvedValue([task_state(9)])
    await emit_event('sync')
    expect(store.tasks.map(entry => entry.task.id)).toEqual([9])
    expect(list_scope_tasks).toHaveBeenCalledTimes(3)
  })

  it('页面卸载释放快照与查询订阅，后续事件不再读取列表', async () => {
    await useContentTaskSync(42)
    cleanup.splice(0).forEach(callback => callback())

    expect(listeners.size).toBe(0)
    await emit_event('refresh')
    expect(list_scope_tasks).toHaveBeenCalledOnce()
  })
})
