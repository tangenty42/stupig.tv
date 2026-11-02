import type { Checkpoint, RecordRow } from './inventory-run'
import type { Reader, Upload, Version } from './oss-inventory'
import { expect, it, vi } from 'vitest'
import { checkpoint_schema, inventory_summary, new_checkpoint, run_inventory } from './inventory-run'

const key = `content/att/images/${'a'.repeat(32)}/${'b'.repeat(32)}.webp`
const time = Date.parse('2026-11-02T00:00:00Z')
const options = { max_requests: 50, max_ms: 60000, pause_ms: 0, now: () => time, wait: async () => {} }
const make_state = (parts = false) => new_checkpoint('target', { prefix: '', min_age_days: 30, parts, page_size: 25 }, time)
const version = (overrides: Partial<Version> = {}): Version => ({ key, version_id: 'version', latest: true, deleted: false, size: 10, etag: 'etag', storage_class: 'Standard', modified_at: '2026-01-01T00:00:00.000Z', ... overrides })
const upload: Upload = { key, upload_id: 'upload', initiated_at: '2026-01-01T00:00:00.000Z' }
function fixture() {
  const records: RecordRow[] = []
  let saved: Checkpoint | null = null
  const sink = { save: vi.fn(async (state: Checkpoint, rows: RecordRow[]) => {
    saved = structuredClone(state)
    records.push(... rows)
  }) }
  const reader: Reader = { configuration: vi.fn(async () => ({})), versions: vi.fn(async () => ({ items: [], next: null })),
    uploads: vi.fn(async () => ({ items: [], next: null })), parts: vi.fn(async () => ({ count: 0, bytes: 0, next: null })) }
  return { reader, records, sink, saved: () => saved! }
}

it('classifies metadata with key-level protection and never emits executable deletion instructions', async () => {
  const f = fixture()
  vi.mocked(f.reader.versions).mockResolvedValueOnce({ items: [version(), version({ version_id: 'old', latest: false }),
    version({ version_id: 'delete', deleted: true, size: 0 }), version({ key: 'unknown/private-name', version_id: 'other' })], next: null })
  vi.mocked(f.reader.uploads).mockResolvedValueOnce({ items: [upload], next: null })
  const state = make_state()
  const result = await run_inventory(state, f.reader, vi.fn(async () => 'none' as const), f.sink, options)
  expect(result.complete).toBe(true)
  expect(f.records.map(row => row.action)).toEqual(['daily_audit_reobserve', 'review_history_retention', 'retain_delete_marker', 'review_unmanaged_namespace', 'review_abort_multipart'])
  expect(f.records.every(row => row.executable === false)).toBe(true)
  expect(result.totals.current_version).toEqual({ count: 2, bytes: 20 })
  expect(JSON.stringify(result)).not.toContain('private-name')
  expect(checkpoint_schema.parse(f.saved())).toEqual(state)
})

it('resumes paired version cursors without counting completed pages twice', async () => {
  const f = fixture()
  vi.mocked(f.reader.versions).mockResolvedValueOnce({ items: [version()], next: { key, id: 'opaque' } })
  const state = make_state()
  const first = await run_inventory(state, f.reader, async () => 'reference', f.sink, { ... options, max_requests: 3 })
  expect(first.complete).toBe(false)
  const resumed = checkpoint_schema.parse(f.saved())
  vi.mocked(f.reader.versions).mockResolvedValueOnce({ items: [version({ latest: false, version_id: 'old' })], next: null })
  const result = await run_inventory(resumed, f.reader, async () => 'reference', f.sink, options)
  expect(f.reader.versions).toHaveBeenLastCalledWith({ key, id: 'opaque' }, 25, '')
  expect(result.totals.current_version).toEqual({ count: 1, bytes: 10 })
  expect(result.totals.historical_version).toEqual({ count: 1, bytes: 10 })
  expect(f.records.every(row => row.action === 'retain_protected_key')).toBe(true)
})

it('keeps denied sections incomplete while independently inventorying multipart uploads', async () => {
  const f = fixture()
  vi.mocked(f.reader.configuration).mockImplementation(async (kind) => {
    if (kind === 'lifecycle')
      throw Object.assign(new Error('secret'), { status: 403 })
    return { Status: 'Enabled' }
  })
  vi.mocked(f.reader.versions).mockRejectedValue(Object.assign(new Error('secret'), { status: 403 }))
  vi.mocked(f.reader.uploads).mockResolvedValue({ items: [upload], next: null })
  const state = make_state()
  const result = await run_inventory(state, f.reader, async () => 'registered_upload', f.sink, options)
  expect(result.complete).toBe(false)
  expect(result.versions.error).toBe('access_denied')
  expect(result.uploads.complete).toBe(true)
  expect(f.records[0]!.action).toBe('retain_protected_key')
  expect(JSON.stringify(result)).not.toContain('secret')
})

it('resumes inside multipart part pagination with correct byte totals', async () => {
  const f = fixture()
  vi.mocked(f.reader.uploads).mockResolvedValue({ items: [upload], next: null })
  vi.mocked(f.reader.parts).mockResolvedValueOnce({ count: 1, bytes: 10, next: 1 }).mockResolvedValueOnce({ count: 1, bytes: 20, next: null })
  await run_inventory(make_state(true), f.reader, async () => 'none', f.sink, { ... options, max_requests: 5 })
  expect(f.records).toHaveLength(0)
  const state = checkpoint_schema.parse(f.saved())
  expect(state.pending!.parts).toEqual({ after: 1, count: 1, bytes: 10 })
  const result = await run_inventory(state, f.reader, async () => 'none', f.sink, options)
  expect(result.complete).toBe(true)
  expect(f.reader.parts).toHaveBeenLastCalledWith(upload, 1, 25)
  expect(f.records[0]!.parts).toEqual({ count: 2, bytes: 30, complete: true, error: null })
})

it('does not double-count a final parts page if the database lookup fails after it', async () => {
  const f = fixture()
  vi.mocked(f.reader.uploads).mockResolvedValue({ items: [upload], next: null })
  vi.mocked(f.reader.parts).mockResolvedValue({ count: 2, bytes: 30, next: null })
  const state = make_state(true)
  await run_inventory(state, f.reader, async () => {
    throw new Error('DB unavailable')
  }, f.sink, options)
  expect(state.pending!.parts.bytes).toBe(0)
  const result = await run_inventory(checkpoint_schema.parse(f.saved()), f.reader, async () => 'none', f.sink, options)
  expect(result.totals.multipart).toEqual({ count: 1, bytes: 30 })
})

it('treats disappeared multipart uploads as observations, not proof of a successful cleanup', async () => {
  const f = fixture()
  vi.mocked(f.reader.uploads).mockResolvedValue({ items: [upload], next: null })
  vi.mocked(f.reader.parts).mockRejectedValue(Object.assign(new Error('upload disappeared'), { status: 404, code: 'NoSuchUpload' }))
  await run_inventory(make_state(true), f.reader, async () => 'none', f.sink, options)
  expect(f.records[0]).toMatchObject({ action: 'upload_disappeared', executable: false, parts: { complete: false, error: 'upload_disappeared' } })
})

it('does not persist an advanced cursor when the detailed record write fails', async () => {
  const f = fixture()
  vi.mocked(f.reader.versions).mockResolvedValue({ items: [version()], next: null })
  f.sink.save.mockImplementation(async (state, rows) => {
    if (rows.length)
      throw new Error('disk unavailable')
    expect(state.versions.complete).toBe(false)
  })
  await expect(run_inventory(make_state(), f.reader, async () => 'none', f.sink, options)).rejects.toThrow('inventory_checkpoint_failed')
})

it('omits private cursor keys and raw lifecycle filters from summaries', () => {
  const state = make_state()
  state.versions.cursor = { key: 'private-name', id: 'private-version' }
  state.configuration.lifecycle = { Rule: { Filter: { Prefix: 'private-name' } } }
  state.configuration_status.lifecycle.complete = true
  expect(JSON.stringify(inventory_summary(state))).not.toMatch(/private-name|private-version/)
})
