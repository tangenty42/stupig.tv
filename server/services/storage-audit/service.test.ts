import type { AuditPool } from './repository'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@config/loader', () => ({ runtime_config: () => ({}) }))
vi.mock('@server/lib/db', () => ({ db: {} }))
const { create_storage_auditor } = await import('./service')
const options = { enabled: true, sweepIntervalSeconds: 30, cycleIntervalSeconds: 86400, retrySeconds: 300,
  leaseSeconds: 300, batchSize: 100, batchBudgetMs: 15000, orphanGraceSeconds: 86400, staticKeys: [] as string[] }
const destination = { bucket: 'test-dev', endpoint: 'https://oss.example.test' }

/** In-memory infrastructure boundary; the real repository and scanner run together. */
function fixture(override = {}) {
  const state = {
    target: { destination_id: '', cycle_id: '', phase: 'completed', row_cursor: 0, role_cursor: 0, object_cursor: null as string | null,
      cycle_started_at: new Date(), references_checked: 0, objects_checked: 0, last_error_code: null as string | null },
    token: '', locked: false, expired: false, due: true, calls: 0,
    files: [] as Record<string, any>[], users: [] as Record<string, any>[],
    cloud: [] as { key: string, size: number, modified_at: Date }[],
    findings: [] as Record<string, any>[], tracked: new Set<string>(), retired: new Set<string>(),
    on_checkpoint: () => {},
  }
  async function execute(sql: string, p: any[] = []): Promise<any> {
    state.calls ++
    const t = state.target
    if (sql.startsWith('INSERT IGNORE INTO storage_audit_targets')) {
      t.destination_id = p[0]
      return [{ affectedRows: 1 }]
    }
    if (sql.startsWith('UPDATE storage_audit_targets SET lease_token=?')) {
      if (state.locked || ! state.due)
        return [{ affectedRows: 0 }]
      state.token = p[0]
      state.locked = true
      return [{ affectedRows: 1 }]
    }
    if (sql.startsWith('SELECT destination_id FROM storage_audit_targets'))
      return [[... (! state.expired && p[1] === state.token ? [{ destination_id: t.destination_id }] : [])]]
    if (sql.startsWith('UPDATE storage_audit_targets SET previous_cycle_id=')) {
      if (t.phase === 'completed')
        Object.assign(t, { cycle_id: p[0], phase: 'attachments', row_cursor: 0, role_cursor: 0, object_cursor: null, references_checked: 0, objects_checked: 0, cycle_started_at: new Date() })
      return [{ affectedRows: 1 }]
    }
    if (sql.startsWith('SELECT * FROM storage_audit_targets'))
      return [[{ ... t }]]
    if (sql.startsWith('UPDATE storage_audit_targets SET lease_until='))
      return [{ affectedRows: ! state.expired && p[2] === state.token ? 1 : 0 }]
    if (sql.startsWith('UPDATE storage_audit_targets SET phase=')) {
      Object.assign(t, { phase: p[0], row_cursor: p[1], role_cursor: p[2], object_cursor: p[3]?.toString() ?? null })
      t.references_checked += p[4]
      t.objects_checked += p[5]
      state.on_checkpoint()
      return [{ affectedRows: 1 }]
    }
    if (sql.startsWith('UPDATE storage_audit_targets SET lease_token=NULL')) {
      state.locked = false
      t.last_error_code = p[0]
      state.due = t.phase !== 'completed'
      return [{ affectedRows: 1 }]
    }
    if (sql.startsWith('INSERT INTO storage_audit_findings')) {
      const found = state.findings.find(x => x.hash === p[1])
      const row = { hash: p[1], key: p[2].toString(), kind: p[3], expected: p[4], observed: p[5], cycle: p[6], resolved: false }
      if (found)
        Object.assign(found, row)
      else state.findings.push({ id: state.findings.length + 1, ... row })
      return [{ affectedRows: 1 }]
    }
    if (sql.startsWith('UPDATE storage_audit_findings SET resolved_at=')) {
      state.findings.find(x => x.id === p[0])!.resolved = true
      return [{ affectedRows: 1 }]
    }
    if (sql.startsWith('SELECT IF(object_key=')) {
      const file = state.files.find(x => Object.values(x).includes(p[0]))
      return [file ? [{ expected_size: file.object_key === p[0] ? file.file_size : null }] : []]
    }
    if (sql.startsWith('SELECT id FROM users'))
      return [state.users.filter(x => x.avatar_file === p[0])]
    if (sql.startsWith('SELECT 1 FROM ('))
      return [state.tracked.has(p[0]) ? [{}] : []]
    if (sql.startsWith('SELECT phase FROM content_object_retirements'))
      return [state.retired.has(p[0]) ? [{ phase: 'completed' }] : []]
    if (sql.startsWith('SELECT id,avatar_file'))
      return [state.users.filter(x => x.id >= p[0]).slice(0, 1)]
    if (sql.startsWith('SELECT id,object_key,kind FROM storage_audit_findings'))
      return [state.findings.filter(x => ! x.resolved && x.cycle !== p[1] && x.id > p[2]).slice(0, 1).map(x => ({ id: x.id, object_key: Buffer.from(x.key), kind: x.kind }))]
    if (sql.startsWith('SELECT id,object_key,original_key'))
      return [state.files.filter(x => x.id >= p[0]).slice(0, 1)]
    throw new Error(`Unhandled SQL: ${sql}`)
  }
  const pool = { execute, getConnection: async () => ({ execute, beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release: () => {} }) } as unknown as AuditPool
  const absent = () => Object.assign(new Error('not found'), { status: 404 })
  const storage = {
    head_object: vi.fn(async (key: string) => {
      const object = state.cloud.find(x => x.key === key)
      if (! object)
        throw absent()
      return { size: object.size, etag: 'etag', version_id: 'v1' }
    }),
    get_object_access: vi.fn(async () => 'private' as const),
    list_page: vi.fn(async (after: string, limit: number) => {
      const remaining = state.cloud.filter(x => Buffer.compare(Buffer.from(x.key), Buffer.from(after)) > 0).sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)))
      return { objects: remaining.slice(0, limit), truncated: remaining.length > limit }
    }),
    find_object: vi.fn(async (key: string) => state.cloud.find(x => x.key === key) ?? null),
  }
  const auditor = create_storage_auditor(pool, storage, destination, { ... options, ... override })
  const add = (key: string, size = 3, modified_at = new Date('2020-01-01')) => state.cloud.push({ key, size, modified_at })
  const open = () => state.findings.filter(x => ! x.resolved).map(x => [x.key, x.kind])
  return { state, pool, storage, auditor, add, open }
}

describe('bucket reconciliation', () => {
  it('checks every attachment role, avatars and configured static assets, without downloading bodies', async () => {
    const f = fixture({ staticKeys: ['imgs/logo.svg'] })
    f.state.files.push({ id: 1, object_key: 'content/att/a', original_key: 'content/att/original', avif_key: 'content/att/avif', jpeg_key: null, redacted_avif_key: 'content/att/redacted', redacted_jpeg_key: null, file_size: 3 })
    f.state.users.push({ id: 1, avatar_file: '1.png' })
    for (const key of ['content/att/a', 'content/att/original', 'content/att/avif', 'content/att/redacted', 'avatar/1.png', 'imgs/logo.svg']) f.add(key)
    await f.auditor.sweep()
    expect(f.state.target.phase).toBe('completed')
    expect(f.state.target.references_checked).toBe(6)
    expect(f.state.target.objects_checked).toBe(6)
    expect(f.open()).toEqual([])
  })

  it('reports missing, wrong-size and public objects while retaining error distinctions', async () => {
    const f = fixture()
    f.state.files.push({ id: 1, object_key: 'content/att/wrong', original_key: 'content/att/missing', file_size: 99 })
    f.add('content/att/wrong')
    f.storage.get_object_access.mockResolvedValue('public-read' as 'private')
    await f.auditor.sweep()
    expect(f.open()).toEqual(expect.arrayContaining([['content/att/wrong', 'size_mismatch'], ['content/att/wrong', 'public_object'], ['content/att/missing', 'missing_object']]))
    const denied = fixture({ staticKeys: ['imgs/logo.svg'] })
    denied.storage.head_object.mockRejectedValue(Object.assign(new Error('signed credentials must not leak'), { status: 403 }))
    await expect(denied.auditor.sweep()).rejects.toThrow('storage_audit_failed')
    expect(denied.open()).toEqual([])
    expect(denied.state.target.last_error_code).toBe('oss_access_denied')
    expect(denied.state.target.phase).not.toBe('completed')
  })

  it('protects tracked work, applies the grace period and distinguishes unknown static prefixes', async () => {
    const f = fixture()
    for (const key of ['content/att/live-task', 'content/att/young', 'content/att/orphan', 'avatar/unused.png', 'imgs/extra.svg', 'other/file', 'content/att/retired', 'folder/']) f.add(key, key === 'folder/' ? 0 : 3)
    f.state.cloud.find(x => x.key.endsWith('/young'))!.modified_at = new Date()
    f.state.tracked.add('content/att/live-task')
    f.state.retired.add('content/att/retired')
    f.state.tracked.add('content/att/retired')
    await f.auditor.sweep()
    expect(f.open()).toEqual(expect.arrayContaining([['content/att/orphan', 'orphan_candidate'], ['avatar/unused.png', 'orphan_candidate'], ['imgs/extra.svg', 'unregistered_static'], ['other/file', 'unmanaged_object'], ['content/att/retired', 'retired_object_present']]))
    expect(f.open()).toHaveLength(5)
  })

  it('checkpoints a partial page, resumes after restart and does not overlap another owner', async () => {
    const f = fixture({ batchSize: 2 })
    f.state.target.phase = 'objects'
    f.state.target.cycle_id = 'cycle'
    for (const key of ['avatar/a.png', 'avatar/b.png', 'avatar/c.png']) f.add(key)
    f.state.locked = true
    await f.auditor.sweep()
    expect(f.storage.list_page).not.toHaveBeenCalled()
    f.state.locked = false
    await f.auditor.sweep()
    expect(f.state.target.object_cursor).toBe('avatar/b.png')
    await f.auditor.sweep()
    expect(f.storage.list_page.mock.calls[1]![0]).toBe('avatar/b.png')
    await f.auditor.sweep()
    expect(f.open()).toHaveLength(3)
    expect(f.state.target.phase).toBe('completed')
  })

  it('fences late HEAD results after a lease expires and keeps the cursor unchanged', async () => {
    const f = fixture({ staticKeys: ['imgs/logo.svg'] })
    f.state.target.phase = 'static'
    f.storage.head_object.mockImplementation(async () => {
      f.state.expired = true
      return { size: 3, etag: 'e', version_id: 'v' }
    })
    await expect(f.auditor.sweep()).rejects.toThrow('storage_audit_failed')
    expect(f.open()).toEqual([])
    expect(f.state.target.row_cursor).toBe(0)
  })

  it('rechecks findings instead of bulk-resolving keys missed by a rolling listing', async () => {
    const f = fixture()
    f.add('avatar/a.png')
    await f.auditor.sweep()
    expect(f.open()).toHaveLength(1)
    f.state.due = true
    f.state.target.phase = 'objects'
    f.state.target.cycle_id = 'second-cycle'
    f.state.target.object_cursor = 'z'
    await f.auditor.sweep()
    expect(f.open()).toHaveLength(1)
    expect(f.storage.find_object).toHaveBeenCalledWith('avatar/a.png')
    f.state.cloud = []
    f.state.due = true
    await f.auditor.sweep()
    expect(f.open()).toEqual([])
  })

  it('ignores a pointer removed during HEAD and stops cooperatively after a committed page item', async () => {
    const f = fixture()
    f.state.files.push({ id: 1, object_key: 'content/att/a', file_size: 3 })
    f.storage.head_object.mockImplementation(async () => {
      f.state.files = []
      throw Object.assign(new Error('absent'), { status: 404 })
    })
    await f.auditor.sweep()
    expect(f.open()).toEqual([])
    const next = fixture()
    next.state.target.phase = 'objects'
    next.add('avatar/a.png')
    next.add('avatar/b.png')
    const controller = new AbortController()
    next.state.on_checkpoint = () => controller.abort()
    await next.auditor.sweep(controller.signal)
    expect(next.state.target.object_cursor).toBe('avatar/a.png')
    expect(next.state.locked).toBe(false)
  })

  it('does not touch either infrastructure when disabled or already aborted', async () => {
    const disabled = fixture({ enabled: false })
    await disabled.auditor.sweep()
    expect(disabled.state.calls).toBe(0)
    const stopped = fixture()
    await stopped.auditor.sweep(AbortSignal.abort())
    expect(stopped.state.calls).toBe(0)
  })
})
