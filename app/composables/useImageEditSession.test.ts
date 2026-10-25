import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { computed, nextTick, ref, shallowRef } from 'vue'
import { useImageEditSession } from './useImageEditSession'

const decode = vi.fn()
const fetch_source = vi.fn()
const canvases: ReturnType<typeof canvas>[] = []
function bitmap(width = 200, height = 100) {
  return { width, height, close: vi.fn() } as unknown as ImageBitmap
}
// Only the browser boundary is replaced. History, dimensions, rendering command
// replay and format validation run the real utils; pixels are checked in Chrome.
function canvas() {
  const context = {
    drawImage: vi.fn(), clearRect: vi.fn(), fillRect: vi.fn(), translate: vi.fn(), rotate: vi.fn(),
    save: vi.fn(), restore: vi.fn(), beginPath: vi.fn(), arc: vi.fn(), fill: vi.fn(), stroke: vi.fn(),
    moveTo: vi.fn(), lineTo: vi.fn(), fillStyle: '',
  }
  return { width: 0, height: 0, getContext: () => context, context,
    toBlob: vi.fn((done: BlobCallback, mime: string) => done(new Blob(['encoded'], { type: mime }))) }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((yes) => {
    resolve = yes
  })
  return { promise, resolve }
}
beforeEach(() => {
  canvases.length = 0
  decode.mockReset().mockImplementation(async () => bitmap())
  fetch_source.mockReset().mockImplementation(async () => ({ ok: true, blob: async () => new Blob(['image']) }))
  for (const [name, value] of Object.entries({ ref, shallowRef, computed, nextTick, createImageBitmap: decode, fetch: fetch_source }))
    vi.stubGlobal(name, value)
  vi.stubGlobal('document', { createElement: () => {
    const value = canvas()
    canvases.push(value)
    return value
  } })
})
afterEach(() => vi.unstubAllGlobals())
function setup() {
  const image = canvas()
  const ink = canvas()
  const source = ref<string | null>('https://static.test/source')
  const mime = ref('image/png')
  const blocked = ref(false)
  const cropping = ref(false)
  const ready = vi.fn()
  const save = vi.fn()
  const error = vi.fn()
  const reset = vi.fn()
  const refit = vi.fn()
  const api: ReturnType<typeof useImageEditSession> = useImageEditSession({ image_canvas: shallowRef(image as unknown as HTMLCanvasElement), stroke_canvas: shallowRef(ink as unknown as HTMLCanvasElement),
    source_url: () => source.value, file_name: () => 'same-name.png', output_mime: () => mime.value,
    busy: () => blocked.value || api.working.value, cropping: () => cropping.value,
    on_ready: ready, on_save: save, on_error: error, refit, reset_tools: reset,
  })
  return { api, image, ink, source, mime, blocked, cropping, ready, save, error, reset, refit }
}
async function settle() {
  await nextTick()
  await nextTick()
}

it('aborts the old request and closes a late decoded bitmap without replacing the next source', async () => {
  const f = setup()
  const late = deferred<ImageBitmap>()
  const stale = bitmap(100, 50)
  const current = bitmap(300, 150)
  const started = deferred<void>()
  decode.mockImplementationOnce(() => {
    started.resolve()
    return late.promise
  }).mockResolvedValueOnce(current)
  const loading = f.api.load_source()
  await started.promise
  expect(decode).toHaveBeenCalledOnce()
  const signal = fetch_source.mock.calls[0]![1].signal as AbortSignal
  f.api.release_source()
  expect(signal.aborted).toBe(true)
  f.source.value = 'https://static.test/next'
  await f.api.load_source()
  late.resolve(stale)
  await loading
  expect(stale.close).toHaveBeenCalledOnce()
  expect(current.close).not.toHaveBeenCalled()
  expect(f.api.source_bitmap.value).toBe(current)
  expect(f.api.natural_size.value).toEqual({ width: 300, height: 150 })
  expect(f.ready).toHaveBeenCalledExactlyOnceWith(current)
})

it('rejects oversized sources, closes their bitmaps and keeps save unavailable', async () => {
  const f = setup()
  const large = bitmap(100_000, 100_000)
  decode.mockResolvedValueOnce(large)
  await f.api.load_source()
  await f.api.submit()
  expect(large.close).toHaveBeenCalledOnce()
  expect(f.api.load_error.value).toContain('图片尺寸过大')
  expect(f.ready).not.toHaveBeenCalled()
  expect(f.save).not.toHaveBeenCalled()
})

it('replays geometry and history while clear removes paint and a new edit replaces the redo branch', async () => {
  const f = setup()
  await f.api.load_source()
  await f.api.commit_action({ kind: 'rotate', direction: 1 })
  expect(f.api.natural_size.value).toEqual({ width: 100, height: 200 })
  await f.api.commit_action({ kind: 'crop', rect: { x: 1, y: 2, width: 40, height: 50 } })
  expect(f.api.natural_size.value).toEqual({ width: 40, height: 50 })
  f.api.undo()
  await settle()
  expect(f.api.natural_size.value).toEqual({ width: 100, height: 200 })
  f.api.redo()
  await settle()
  expect(f.api.natural_size.value).toEqual({ width: 40, height: 50 })
  f.api.undo()
  await settle()
  await f.api.commit_action({ kind: 'stroke', stroke: { width: 4, points: [{ x: 3, y: 4 }] } })
  expect(f.api.can_redo.value).toBe(false)
  expect(f.api.has_paint.value).toBe(true)
  f.api.clear_strokes()
  await settle()
  expect(f.api.has_paint.value).toBe(false)
  expect(f.api.natural_size.value).toEqual({ width: 100, height: 200 })
  expect(f.ink.context.clearRect).toHaveBeenCalled()
})

it('blocks history and export during a gesture or crop and releases all owned resources', async () => {
  const f = setup()
  await f.api.load_source()
  const source = f.api.source_bitmap.value!
  await f.api.commit_action({ kind: 'rotate', direction: 1 })
  f.blocked.value = true
  f.api.undo()
  await f.api.submit()
  expect(f.api.history.value.index).toBe(1)
  f.blocked.value = false
  f.cropping.value = true
  f.api.undo()
  await f.api.submit()
  expect(f.api.history.value.index).toBe(1)
  expect(f.save).not.toHaveBeenCalled()
  f.api.release_source()
  expect(source.close).toHaveBeenCalledOnce()
  expect(f.reset).toHaveBeenCalledOnce()
  expect(f.api.source_bitmap.value).toBeNull()
  expect(f.api.history.value).toEqual({ actions: [], index: 0 })
  expect([f.image.width, f.image.height, f.ink.width, f.ink.height]).toEqual([0, 0, 0, 0])
})

it('exports the selected crop with paint without changing history on repeated saves', async () => {
  const f = setup()
  await f.api.load_source()
  const before = f.api.history.value
  for (let attempt = 0; attempt < 2; attempt ++) {
    await f.api.submit({ x: 1, y: 1, width: 2, height: 2 })
    const exported = canvases.at(- 1)!
    expect(exported.context.drawImage).toHaveBeenCalledWith(f.image, - 1, - 1)
    expect(exported.context.drawImage).toHaveBeenCalledWith(f.ink, - 1, - 1)
    expect(f.api.history.value).toBe(before)
  }
  expect(f.save).toHaveBeenCalledTimes(2)
})

it('flattens JPEG onto white and preserves the caller file name and MIME', async () => {
  const f = setup()
  await f.api.load_source()
  f.mime.value = 'image/jpeg'
  await f.api.submit()
  const exported = canvases.at(- 1)!
  expect(exported.context.fillStyle).toBe('#ffffff')
  expect(exported.context.fillRect.mock.invocationCallOrder[0]).toBeLessThan(exported.context.drawImage.mock.invocationCallOrder[0]!)
  const file = f.save.mock.calls[0]![0] as File
  expect([file.name, file.type]).toEqual(['same-name.png', 'image/jpeg'])
  expect([exported.width, exported.height]).toEqual([0, 0])
})

it('does not emit an export that completes after close or source replacement', async () => {
  const f = setup()
  await f.api.load_source()
  const create = document.createElement
  let finish!: BlobCallback
  vi.stubGlobal('document', { createElement: () => {
    const target = create.call(document, 'canvas') as unknown as ReturnType<typeof canvas>
    target.toBlob.mockImplementation((done) => {
      finish = done
    })
    return target
  } })
  const pending = f.api.submit()
  expect(f.api.working.value).toBe(true)
  f.api.release_source()
  finish(new Blob(['encoded'], { type: 'image/png' }))
  await pending
  expect(f.save).not.toHaveBeenCalled()
  expect(f.error).not.toHaveBeenCalled()
  expect(f.api.working.value).toBe(false)
  expect(canvases.at(- 1)!.width).toBe(0)
})

it('keeps edits on an encoding failure so the same save can be retried', async () => {
  const f = setup()
  await f.api.load_source()
  await f.api.commit_action({ kind: 'rotate', direction: 1 })
  const create = document.createElement
  let failing = true
  vi.stubGlobal('document', { createElement: () => {
    const target = create.call(document, 'canvas') as unknown as ReturnType<typeof canvas>
    target.toBlob.mockImplementation((done, mime) => done(failing ? null : new Blob(['encoded'], { type: mime })))
    return target
  } })
  await f.api.submit()
  expect(f.error).toHaveBeenCalledExactlyOnceWith('导出图片失败，请保留编辑并重试')
  expect(f.api.history.value.index).toBe(1)
  expect(f.api.source_bitmap.value).not.toBeNull()
  failing = false
  await f.api.submit()
  expect(f.save).toHaveBeenCalledOnce()
})
