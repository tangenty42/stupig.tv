import type { ContentUploadSession } from '@shared/types/content-upload'
import { createHash } from 'node:crypto'
import { expect, it, vi } from 'vitest'
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
