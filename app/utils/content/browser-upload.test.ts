import type { ContentUploadSession } from '@shared/types/content-upload'
import { createHash } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { create_browser_upload, verify_upload_file } from './browser-upload'

const digest = (bytes: string) => createHash('md5').update(bytes).digest('hex')
const part = (number: number, bytes: string) => ({ part_number: number, size: bytes.length, etag: digest(bytes) })

it('does not read any file bytes before a first upload', async () => {
  const file = new File([new Uint8Array(9 * 1024 ** 2)], 'large.bin')
  const read = vi.spyOn(file, 'slice')
  const progress = vi.fn()
  await verify_upload_file(file, { size: file.size, part_size: 8 * 1024 ** 2, parts: [] }, undefined, progress)
  expect(read).not.toHaveBeenCalled()
  expect(progress).not.toHaveBeenCalled()
})

it('checks only confirmed noncontiguous parts and reports their actual byte total', async () => {
  const file = new File(['abcdefghij'], 'file.bin')
  const read = vi.spyOn(file, 'slice')
  const progress = vi.fn()
  await verify_upload_file(file, { size: 10, part_size: 4, parts: [part(1, 'abcd'), part(3, 'ij')] }, undefined, progress)
  expect(read.mock.calls).toEqual([[0, 4], [8, 10]])
  expect(progress.mock.calls.map(([value]) => value)).toEqual([
    { phase: 'checking', loaded: 0, total: 6 }, { phase: 'checking', loaded: 4, total: 6 }, { phase: 'checking', loaded: 6, total: 6 },
  ])
})

it('rejects a different-size file without reading it', async () => {
  const file = new Blob(['abc'])
  const read = vi.spyOn(file, 'slice')
  await expect(verify_upload_file(file, { size: 4, part_size: 4, parts: [] })).rejects.toThrow('内容一致')
  expect(read).not.toHaveBeenCalled()
})

it('rejects a reselected same-size file that disagrees with an uploaded part before any new OSS work', async () => {
  const state = { id: 'a'.repeat(32), size: 3, status: 'uploading', part_size: 3, parts: [part(1, 'abc')] } as ContentUploadSession
  const api = { resume: vi.fn().mockResolvedValue(state), initialize: vi.fn(), sign: vi.fn(), seal: vi.fn(), cancel: vi.fn() }
  await expect(create_browser_upload(api).run(new File(['xyz'], 'same.bin'))).rejects.toThrow('内容一致')
  expect(api.sign).not.toHaveBeenCalled()
  expect(api.seal).not.toHaveBeenCalled()
})

it('allows new suffix bytes when the reselected file agrees with every already uploaded part', async () => {
  await expect(verify_upload_file(new Blob(['abcXYZ']), { size: 6, part_size: 3, parts: [part(1, 'abc')] })).resolves.toBeUndefined()
})

it('checks an already-aborted signal before touching a file', async () => {
  const controller = new AbortController()
  controller.abort()
  const file = new Blob(['abc'])
  const read = vi.spyOn(file, 'slice')
  await expect(verify_upload_file(file, { size: 3, part_size: 3, parts: [part(1, 'abc')] }, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
  expect(read).not.toHaveBeenCalled()
})

it('stops after a pending part read when cancellation wins', async () => {
  const file = new Blob(['abcdef'])
  let resolve!: (bytes: ArrayBuffer) => void
  const read = vi.spyOn(file, 'slice').mockReturnValueOnce({ arrayBuffer: () => new Promise(done => resolve = done) } as Blob)
  const controller = new AbortController()
  const progress = vi.fn()
  const pending = verify_upload_file(file, { size: 6, part_size: 3, parts: [part(1, 'abc'), part(2, 'def')] }, controller.signal, progress)
  controller.abort()
  resolve(new TextEncoder().encode('abc').buffer)
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  expect(read).toHaveBeenCalledOnce()
  expect(progress).toHaveBeenCalledOnce()
})

it.each([
  [part(0, 'abc')], [part(2, 'abc')], [part(1, 'abc'), part(1, 'abc')], [{ ... part(1, 'abc'), size: 2 }], [{ ... part(1, 'abc'), etag: 'not-a-part-md5' }],
].map(parts => ({ parts })))('rejects malformed or duplicate confirmed parts before reading bytes: %j', async ({ parts }) => {
  const file = new Blob(['abc'])
  const read = vi.spyOn(file, 'slice')
  await expect(verify_upload_file(file, { size: 3, part_size: 3, parts })).rejects.toThrow('分片计划无效')
  expect(read).not.toHaveBeenCalled()
})

it('replays a ready receipt without reading, uploading or completing again', async () => {
  const state = { id: 'a'.repeat(32), size: 3, status: 'ready', parts: [] } as unknown as ContentUploadSession
  const api = { resume: vi.fn().mockResolvedValue(state), initialize: vi.fn(), sign: vi.fn(), seal: vi.fn(), cancel: vi.fn() }
  const file = new File(['abc'], 'file.bin')
  const read = vi.spyOn(file, 'slice')
  expect(await create_browser_upload(api).run(file)).toBe(state)
  expect(read).not.toHaveBeenCalled()
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
