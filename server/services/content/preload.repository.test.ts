import type { Connection } from 'mysql2/promise'
import { beforeEach, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ enabled: true }))
vi.mock('@config/loader', () => ({ runtime_config: () => ({ app: { contentPreload: { enabled: state.enabled, maxObjectBytes: 100 } },
  aliyun: { esa: { baseUrl: 'https://edge.example.test' }, esaPurge: { siteId: '123' } } }) }))
const { enqueue_preload, preload_destination } = await import('./preload.repository')
beforeEach(() => {
  state.enabled = true
})

it('captures the exact destination and display object identity inside the publishing connection', async () => {
  const execute = vi.fn()
  await enqueue_preload({ execute } as unknown as Connection, 7, 8, [{ key: 'content/att/image.avif', size: 20 }])
  expect(execute.mock.calls[0]![1]).toEqual([preload_destination('123', 'https://edge.example.test'), '123', 'https://edge.example.test'])
  expect(execute.mock.calls[1]![0]).toContain('INSERT IGNORE INTO content_preload_jobs')
  expect(execute.mock.calls[1]![1]).toEqual([preload_destination('123', 'https://edge.example.test'), 7, 8, 'content/att/image.avif'])
})

it('does not enqueue disabled, oversized, empty or malformed representations', async () => {
  const execute = vi.fn()
  const connection = { execute } as unknown as Connection
  state.enabled = false
  await enqueue_preload(connection, 7, 8, [{ key: 'content/att/a', size: 20 }])
  expect(execute).not.toHaveBeenCalled()
  state.enabled = true
  await enqueue_preload(connection, 7, 8, [{ key: 'content/att/a', size: 101 }, { key: 'content/att/b', size: 0 }])
  expect(execute).not.toHaveBeenCalled()
  await expect(enqueue_preload(connection, 7, 8, [{ key: 'other/path?secret', size: 20 }])).rejects.toThrow()
})
