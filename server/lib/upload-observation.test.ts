import { expect, it, vi } from 'vitest'
import { create_upload_observer } from './upload-observation'

it('records returned and failed stages while preserving values, errors and safe identities', async () => {
  let now = 0
  const log = vi.fn()
  const observer = create_upload_observer(() => now, log)
  const fields = { session_id: 'a'.repeat(32), job_id: 'signed-url-secret', filename: 'private-name', execution_epoch: 2 }
  const result = { adopted: true }
  await expect(observer.measure('upload_adopt', async () => {
    now = 12
    return result
  }, fields)).resolves.toBe(result)
  const error = new Error('credential=secret')
  await expect(observer.measure('upload_seal', async () => {
    now = 19
    throw error
  })).rejects.toBe(error)
  expect(log.mock.calls[0]).toEqual(['upload_stage', { stage: 'upload_adopt', outcome: 'returned', duration_ms: 12, session_id: fields.session_id,
    execution_epoch: 2, db_acquire_ms: 0, db_acquisitions: 0 }])
  expect(observer.snapshot()).toEqual(expect.arrayContaining([
    expect.objectContaining({ stage: 'upload_adopt', count: 1, failed: 0, active: 0, recent_p95_ms: 12 }),
    expect.objectContaining({ stage: 'upload_seal', count: 1, failed: 1, active: 0, total_ms: 7 }),
  ]))
  expect(JSON.stringify(log.mock.calls)).not.toMatch(/secret|filename|private-name/)
})

it('keeps recent samples bounded and reports their actual sample count', () => {
  const observer = create_upload_observer(() => 0, vi.fn())
  for (let i = 0; i < 200; i ++)
    observer.duration('image_queue', i)
  observer.duration('image_queue', Number.NaN)
  observer.duration('image_queue', - 1)
  expect(observer.snapshot()).toEqual([expect.objectContaining({ stage: 'image_queue', count: 200, recent_count: 128, recent_p95_ms: 193, max_ms: 199 })])
  expect(JSON.stringify(observer.snapshot())).not.toContain('session_id')
})

it('attributes connection acquisition to the requesting context even when another context finishes it', async () => {
  let now = 0
  const log = vi.fn()
  const observer = create_upload_observer(() => now, log)
  let finish_a!: (failed?: boolean) => void
  let finish_b!: (failed?: boolean) => void
  let release_a!: () => void
  let release_b!: () => void
  const a = observer.measure('upload_adopt', async () => {
    finish_a = observer.database_wait()
    await new Promise<void>(resolve => release_a = resolve)
  }, { session_id: 'a'.repeat(32) })
  const b = observer.measure('upload_adopt', async () => {
    finish_b = observer.database_wait()
    await new Promise<void>(resolve => release_b = resolve)
  }, { session_id: 'b'.repeat(32) })
  expect(observer.snapshot()).toEqual(expect.arrayContaining([expect.objectContaining({ stage: 'db_acquire', active: 2, peak_active: 2 })]))
  now = 10
  finish_a()
  finish_a()
  now = 25
  finish_b(true)
  release_a()
  release_b()
  await Promise.all([a, b])
  expect(log.mock.calls).toEqual(expect.arrayContaining([
    ['upload_stage', expect.objectContaining({ session_id: 'a'.repeat(32), db_acquire_ms: 10, db_acquisitions: 1 })],
    ['upload_stage', expect.objectContaining({ session_id: 'b'.repeat(32), db_acquire_ms: 25, db_acquisitions: 1 })],
  ]))
  expect(observer.snapshot()).toEqual(expect.arrayContaining([expect.objectContaining({ stage: 'db_acquire', count: 2, failed: 1, active: 0 })]))
})

it('inherits session identity through nested image stages and tolerates a failing log sink', async () => {
  const log = vi.fn()
  const observer = create_upload_observer(() => 0, log)
  await observer.with_context({ session_id: 'a'.repeat(32) }, () => observer.measure('image_job',
    () => observer.measure('image_display', async () => 7), { job_id: 'b'.repeat(32), execution_epoch: 3 }))
  expect(log.mock.calls).toEqual(expect.arrayContaining([['upload_stage', expect.objectContaining({ stage: 'image_display', session_id: 'a'.repeat(32), job_id: 'b'.repeat(32), execution_epoch: 3 })]]))
  const unavailable = create_upload_observer(() => 0, () => {
    throw new Error('log unavailable')
  })
  await expect(unavailable.measure('upload_adopt', async () => 9)).resolves.toBe(9)
})
