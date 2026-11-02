import { expect, it, vi } from 'vitest'
import { create_upload_timeline } from './upload-timeline'

function fixture() {
  const marks = new Set<string>()
  const measures = new Set<string>()
  const api = {
    mark: vi.fn((name: string) => { marks.add(name) }),
    measure: vi.fn((name: string, from: string, to: string) => {
      expect(marks.has(from) && marks.has(to)).toBe(true)
      measures.add(name)
    }),
    clearMarks: vi.fn((name: string) => { marks.delete(name) }),
    clearMeasures: vi.fn((name: string) => { measures.delete(name) }),
  }
  return { api: api as unknown as Performance, marks, measures }
}

it('records existing browser stages without filenames and clears temporary marks', async () => {
  const f = fixture()
  const trace = create_upload_timeline('a'.repeat(32), f.api)
  trace.start('total')
  expect(await trace.measure('seal', async () => 7)).toBe(7)
  trace.start('dom_update')
  trace.finish('dom_update')
  trace.stop('returned')
  expect([... f.measures].map(name => name.split('.').slice(- 2).join('.'))).toEqual(['seal.returned', 'dom_update.returned', 'total.returned'])
  expect(f.marks.size).toBe(0)
})

it('bounds browser history across sessions and disposes a still-running old identity', async () => {
  const f = fixture()
  const repeated = create_upload_timeline('a'.repeat(32), f.api)
  for (let i = 0; i < 160; i ++)
    await repeated.measure('seal', async () => {})
  expect(f.measures.size).toBe(128)
  const trace = create_upload_timeline('b'.repeat(32), f.api)
  let release!: () => void
  const running = trace.measure('adopt', () => new Promise<void>(resolve => release = resolve))
  trace.dispose()
  release()
  await running
  expect([... f.measures].some(name => name.includes('b'.repeat(32)))).toBe(false)
  expect(f.marks.size).toBe(0)
})

it('measures overlapping adoption calls independently', async () => {
  const f = fixture()
  const trace = create_upload_timeline('a'.repeat(32), f.api)
  let first!: () => void
  let second!: () => void
  const a = trace.measure('adopt', () => new Promise<void>(resolve => first = resolve))
  const b = trace.measure('adopt', () => new Promise<void>(resolve => second = resolve))
  first()
  await a
  expect([... f.measures].filter(name => name.endsWith('.adopt.returned'))).toHaveLength(1)
  expect(f.marks.size).toBe(1)
  second()
  await b
  expect([... f.measures].filter(name => name.endsWith('.adopt.returned'))).toHaveLength(2)
  expect(f.marks.size).toBe(0)
})

it('preserves failures and return values even if Performance is unavailable or throws', async () => {
  const api = { mark: () => {
    throw new Error('not supported')
  } } as unknown as Performance
  const trace = create_upload_timeline('a'.repeat(32), api)
  expect(await trace.measure('adopt', async () => 5)).toBe(5)
  const error = new Error('upload rejected')
  await expect(trace.measure('seal', async () => {
    throw error
  })).rejects.toBe(error)
  expect(await create_upload_timeline('invalid-id', fixture().api).measure('resume', async () => 9)).toBe(9)
})

it('keeps an HTTP measurement open when a notification completes the DOM first', async () => {
  const f = fixture()
  const idle = vi.fn()
  const trace = create_upload_timeline('a'.repeat(32), f.api, idle)
  let reply!: () => void
  trace.start('total')
  const seal = trace.measure('seal', () => new Promise<void>(resolve => reply = resolve))
  trace.start('dom_update')
  trace.complete()
  expect([... f.measures].some(name => name.endsWith('.seal.returned'))).toBe(false)
  expect(idle).not.toHaveBeenCalled()
  reply()
  await seal
  expect([... f.measures].some(name => name.endsWith('.seal.returned'))).toBe(true)
  expect(idle).toHaveBeenCalled()
  expect(f.marks.size).toBe(0)
})
