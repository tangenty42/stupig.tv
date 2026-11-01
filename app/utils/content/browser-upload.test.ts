import type { ContentUploadSession } from '@shared/types/content-upload'
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { create_browser_upload, upload_file_sha256 } from './browser-upload'

it('hashes a file across chunk boundaries with the standard full SHA-256', async () => {
  const bytes = new Uint8Array(8 * 1024 ** 2 + 17).fill(42)
  const progress = vi.fn()
  expect(await upload_file_sha256(new Blob([bytes]), undefined, progress)).toBe(createHash('sha256').update(bytes).digest('hex'))
  expect(progress).toHaveBeenCalledTimes(2)
})

it('stops hashing when paused without issuing an upload request', async () => {
  const controller = new AbortController()
  controller.abort()
  await expect(upload_file_sha256(new Blob(['abc']), controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
})

it('reuses only the exact immutable file object, never a same-name/size selection', async () => {
  const file = new File(['abc'], 'same.bin')
  const reads = vi.spyOn(file, 'slice')
  const expected = createHash('sha256').update('abc').digest('hex')
  expect(await upload_file_sha256(file)).toBe(expected)
  expect(await upload_file_sha256(file)).toBe(expected)
  expect(reads).toHaveBeenCalledOnce()
  const reselected = new File(['xyz'], 'same.bin')
  expect(await upload_file_sha256(reselected)).toBe(createHash('sha256').update('xyz').digest('hex'))
  const controller = new AbortController()
  controller.abort()
  await expect(upload_file_sha256(file, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
})

describe('large-file hash worker boundary', () => {
  const workers: HashWorker[] = []
  class HashWorker {
    onmessage: ((event: MessageEvent) => void) | null = null
    onerror: ((event: ErrorEvent) => void) | null = null
    postMessage = vi.fn()
    terminate = vi.fn()
    constructor() { workers.push(this) }
  }
  afterEach(() => {
    workers.length = 0
    vi.unstubAllGlobals()
  })

  it('uses a worker for a chunk-sized file, reports progress and releases it', async () => {
    vi.stubGlobal('Worker', HashWorker)
    const file = new Blob([new Uint8Array(8 * 1024 ** 2)])
    const progress = vi.fn()
    const pending = upload_file_sha256(file, undefined, progress)
    const worker = workers[0]!
    expect(worker.postMessage).toHaveBeenCalledWith({ file, chunk_size: 8 * 1024 ** 2 })
    worker.onmessage!({ data: { type: 'progress', loaded: 1024 } } as MessageEvent)
    expect(progress).toHaveBeenCalledWith({ phase: 'hashing', loaded: 1024, total: file.size })
    const digest = createHash('sha256').update(new Uint8Array(file.size)).digest('hex')
    worker.onmessage!({ data: { type: 'done', sha256: digest } } as MessageEvent)
    expect(await pending).toBe(digest)
    expect(worker.terminate).toHaveBeenCalledOnce()
    expect(await upload_file_sha256(file)).toBe(digest)
    expect(workers).toHaveLength(1)
  })

  it('terminates cancellation and ignores a late progress callback', async () => {
    vi.stubGlobal('Worker', HashWorker)
    const controller = new AbortController()
    const progress = vi.fn()
    const pending = upload_file_sha256(new Blob([new Uint8Array(8 * 1024 ** 2)]), controller.signal, progress)
    const worker = workers[0]!
    const late = worker.onmessage!
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    late({ data: { type: 'progress', loaded: 1000 } } as MessageEvent)
    expect(progress).not.toHaveBeenCalled()
    expect(worker.terminate).toHaveBeenCalledOnce()
  })

  it('falls back to bounded hashing if worker startup fails', async () => {
    vi.stubGlobal('Worker', HashWorker)
    const file = new Blob([new Uint8Array(8 * 1024 ** 2).fill(7)])
    const pending = upload_file_sha256(file)
    workers[0]!.onerror!(new Event('error') as ErrorEvent)
    expect(await pending).toBe(createHash('sha256').update(new Uint8Array(file.size).fill(7)).digest('hex'))
    expect(workers[0]!.terminate).toHaveBeenCalledOnce()
  })

  it('surfaces file-read errors without restarting a second whole-file scan', async () => {
    vi.stubGlobal('Worker', HashWorker)
    const file = new Blob([new Uint8Array(8 * 1024 ** 2)])
    const reads = vi.spyOn(file, 'slice')
    const pending = upload_file_sha256(file)
    workers[0]!.onmessage!({ data: { type: 'error' } } as MessageEvent)
    await expect(pending).rejects.toThrow('重新选择')
    expect(reads).not.toHaveBeenCalled()
    expect(workers[0]!.terminate).toHaveBeenCalledOnce()
  })
})

it('rejects a reselected same-size file with different contents before contacting OSS', async () => {
  const state = { id: 'a'.repeat(32), size: 3, sha256: createHash('sha256').update('abc').digest('hex'), status: 'uploading' } as ContentUploadSession
  const api = { resume: vi.fn().mockResolvedValue(state), initialize: vi.fn(), sign: vi.fn(), seal: vi.fn(), cancel: vi.fn() }
  await expect(create_browser_upload(api).run(new File(['xyz'], 'same.bin'))).rejects.toThrow('内容一致')
  expect(api.sign).not.toHaveBeenCalled()
  expect(api.seal).not.toHaveBeenCalled()
})

it('replays a ready receipt without uploading or completing again', async () => {
  const state = { id: 'a'.repeat(32), size: 3, sha256: createHash('sha256').update('abc').digest('hex'), status: 'ready' } as ContentUploadSession
  const api = { resume: vi.fn().mockResolvedValue(state), initialize: vi.fn(), sign: vi.fn(), seal: vi.fn(), cancel: vi.fn() }
  expect(await create_browser_upload(api).run(new File(['abc'], 'file.bin'))).toBe(state)
  expect(api.sign).not.toHaveBeenCalled()
  expect(api.seal).not.toHaveBeenCalled()
})

it('does not initialize a session when pause wins a pending resume request', async () => {
  let resolve!: (value: ContentUploadSession) => void
  const api = {
    resume: vi.fn(() => new Promise<ContentUploadSession>((done) => {
      resolve = done
    })),
    initialize: vi.fn(), sign: vi.fn(), seal: vi.fn(), cancel: vi.fn(),
  }
  const driver = create_browser_upload(api)
  const run = driver.run(new File(['abc'], 'file.bin'))
  driver.pause()
  resolve({ status: 'queued' } as ContentUploadSession)
  await expect(run).rejects.toMatchObject({ name: 'AbortError' })
  expect(api.initialize).not.toHaveBeenCalled()
  expect(api.sign).not.toHaveBeenCalled()
})
