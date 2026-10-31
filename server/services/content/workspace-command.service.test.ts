import type { WorkspaceRow } from './workspace.repository'
import { wire_resource } from '@server/lib/sync-channel'
import { workspace_command_schema } from '@shared/content-workspace'
import { beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ execute: vi.fn(), query: vi.fn(), commit: vi.fn(), rollback: vi.fn(), release: vi.fn(), refresh: vi.fn(), storage: vi.fn() }))
vi.mock('@config/loader', () => ({ runtime_config: () => ({ aliyun: {
  oss: { bucket: 'test-bucket', endpoint: 'https://oss.example.test' },
  esa: { baseUrl: 'https://cdn.example.test' }, esaPurge: { siteId: 'test-site' },
}, app: { auth: { jwt: { secret: 'workspace-test-secret' } } } }) }))
vi.mock('@server/lib/db', () => ({ db: {
  execute: mocks.execute,
  getConnection: async () => ({ execute: mocks.execute, query: mocks.query, beginTransaction: vi.fn(), commit: mocks.commit, rollback: mocks.rollback, release: mocks.release }),
} }))
vi.mock('@server/lib/sync', () => ({ publish_refresh: mocks.refresh, sync_resource: (type: string, id: number) => ({ type, id }) }))
vi.mock('@server/lib/aliyun-oss', () => ({ create_aliyun_oss: mocks.storage }))

const { execute_workspace_command } = await import('./workspace-command.service')
const { node_version } = await import('./workspace.repository')
let rows: WorkspaceRow[]
let admin: boolean
let receipts: Map<string, { fingerprint: string, result: string }>
let story: { markdown: string, cover: string, cover_version: string | null }
let reservations: { id: string, target_parent_id: number, target_path: string, target_name_key?: string, intent: { target_name: string } }[]
let expired: { id: string }[]

beforeEach(() => {
  vi.clearAllMocks()
  admin = true
  receipts = new Map()
  story = { markdown: '[a](att://a.txt)', cover: '', cover_version: null }
  reservations = []
  expired = []
  // Observe committed outbox rows at the SQL boundary, not MQTT delivery.
  let pending: { resource: string }[] = []
  mocks.commit.mockImplementation(async () => {
    pending.forEach(event => mocks.refresh(event))
    pending = []
  })
  mocks.rollback.mockImplementation(async () => {
    pending = []
  })
  const root = { id: 1, story_id: 1, parent_id: 0, name: '', name_key: '', file_name: '', is_folder: 1, node_revision: 1, read_revision: 1, object_key: null, version: '', is_private: 0, storage_provider: 'aliyun', encryption_key: null, file_size: 0, mime_type: null, oss_version_id: null }
  rows = [root, { ... root, id: 2, parent_id: 1, name: 'docs', name_key: 'docs', file_name: 'docs' }, ... ['a.txt', 'b.txt'].map((name, i) => ({ ... root, id: i + 3, parent_id: 1, name, name_key: name, file_name: name, is_folder: 0, object_key: `key-${i}`, version: 'v1' }))] as WorkspaceRow[]
  mocks.execute.mockImplementation(async (sql: string, args: unknown[] = []) => {
    if (sql.includes('FROM content_story_drafts'))
      return [[]]
    if (sql.startsWith('INSERT INTO content_sync_outbox'))
      pending.push(JSON.parse(String(args[2])))
    if (sql.includes('FROM users'))
      return [[{ id: 7, is_admin: admin, is_banned: 0, permissions: admin ? [] : [{ field: 'content_manage', level: 'full' }] }]]
    if (sql.includes('FROM content_command_receipts'))
      return [[... (receipts.has(String(args[1])) ? [receipts.get(String(args[1]))!] : [])]]
    if (sql.startsWith('INSERT INTO content_command_receipts'))
      receipts.set(String(args[1]), { fingerprint: String(args[3]), result: String(args[4]) })
    if (sql.includes('FROM content_stories'))
      return [[{ id: 1, namespace_revision: 1, ... story }]]
    if (sql.includes('FROM content_story_attachments')) {
      if (sql.startsWith('SELECT'))
        return [structuredClone(rows)]
    }
    if (sql.startsWith('DELETE FROM content_story_attachments'))
      rows = rows.filter(row => row.id !== args[0])
    if (sql.startsWith('INSERT INTO content_story_attachments')) {
      const id = Math.max(... rows.map(row => row.id)) + 1
      rows.push({ ... rows[0]!, id, parent_id: Number(args[1]), name: String(args[2]), name_key: String(args[3]), file_name: String(args[4]), is_private: Number(args[5]) })
      return [{ insertId: id, affectedRows: 1 }]
    }
    if (sql.includes('FROM content_transfer_sessions') && sql.includes('expires_at >'))
      return [reservations]
    if (sql.includes('FROM content_transfer_sessions') && sql.includes('expires_at <='))
      return [expired]
    if (sql.includes('FROM content_transfer_sessions') || sql.includes('FROM content_object_retirements'))
      return [[]]
    if (sql.startsWith('UPDATE content_story_attachments SET parent_id')) {
      const row = rows.find(row => row.id === args[4])!
      Object.assign(row, { parent_id: args[0], name: args[1], name_key: args[2], is_private: args[3], node_revision: row.node_revision + 1 })
    }
    if (sql.startsWith('UPDATE content_story_attachments SET file_name'))
      rows.find(row => row.id === args[1])!.file_name = String(args[0])
    if (sql.startsWith('UPDATE content_story_attachments SET read_revision')) {
      const row = rows.find(row => row.id === args[0])!
      row.read_revision = Number(row.read_revision) + 1
    }
    if (sql.startsWith('UPDATE content_story_attachments SET is_private')) {
      const row = rows.find(row => row.id === args[1])!
      Object.assign(row, { is_private: args[0], read_revision: Number(row.read_revision) + 1, node_revision: Number(row.node_revision) + 1 })
    }
    if (sql.startsWith('UPDATE content_story_attachments SET redacted_avif_key')) {
      const row = rows.find(row => row.id === args[0])!
      Object.assign(row, { redacted_avif_key: null, redacted_jpeg_key: null, redacted_metadata: null, redacted_lqip_jpeg: null,
        redacted_revision: Number(row.redacted_revision) + 1, read_revision: Number(row.read_revision) + 1, node_revision: Number(row.node_revision) + 1 })
    }
    return [{ affectedRows: 1 }]
  })
})

function command(ids: number[], private_value: boolean) {
  const parsed = workspace_command_schema.parse({
    operation: 'set_private', request_id: crypto.randomUUID(), scope_id: 1, private: private_value,
    targets: ids.map(id => ({ id, version: node_version(rows, rows.find(row => row.id === id)!) })),
  })
  if (parsed.operation !== 'set_private')
    throw new Error('Expected a privacy command')
  return parsed
}
const updates = () => mocks.execute.mock.calls.filter(([sql]) => String(sql).startsWith('UPDATE content_story_attachments SET parent_id'))
const resources = () => mocks.refresh.mock.calls.map(([event]) => event.resource).sort()

it('uses the privacy command for a whole directory, preserves independent markers and redacted keys, and replays once', async () => {
  Object.assign(rows[2]!, { parent_id: 2, file_name: 'docs/a.txt', redacted_avif_key: 'kept-avif', redacted_jpeg_key: 'kept-jpeg' })
  Object.assign(rows[3]!, { parent_id: 2, name: 'b.txt.good', name_key: 'b.txt.good', file_name: 'docs/b.txt.good', is_private: 1 })
  rows.push({ ... rows[1]!, id: 5, parent_id: 2, name: 'nested', name_key: 'nested', file_name: 'docs/nested' },
    { ... rows[2]!, id: 6, parent_id: 5, name: 'deep.txt', name_key: 'deep.txt', file_name: 'docs/nested/deep.txt' },
    { ... rows[1]!, id: 7, parent_id: 2, name: 'own.good', name_key: 'own.good', file_name: 'docs/own.good', is_private: 1 },
    { ... rows[2]!, id: 8, parent_id: 7, name: 'own.txt', name_key: 'own.txt', file_name: 'docs/own.good/own.txt', is_private: 1 })
  story.markdown = '[a](att://docs/a.txt)\n\n[](att://docs)'
  const input = command([2, 3], true)
  const report = await execute_workspace_command(7, input)
  expect(report.succeeded).toEqual(['docs.good'])
  expect(rows[1]).toMatchObject({ name: 'docs.good', is_private: 1, read_revision: 2 })
  expect(rows[2]).toMatchObject({ file_name: 'docs.good/a.txt', is_private: 1, read_revision: 2, node_revision: 2 })
  expect(rows[4]).toMatchObject({ file_name: 'docs.good/nested', is_private: 1, read_revision: 2 })
  expect(rows[5]).toMatchObject({ file_name: 'docs.good/nested/deep.txt', is_private: 1, read_revision: 2 })
  expect(rows[3]).toMatchObject({ file_name: 'docs.good/b.txt.good', is_private: 1, read_revision: 1 })
  const writes = mocks.execute.mock.calls.filter(([sql]) => String(sql).startsWith('UPDATE content_stories SET'))
  expect(writes.some(([, args]) => args.includes('[a](att://docs.good/a.txt)\n\n[](att://docs.good)'))).toBe(true)
  const after = structuredClone(rows)
  await expect(execute_workspace_command(7, input)).resolves.toEqual(report)
  expect(rows).toEqual(after)
  await execute_workspace_command(7, command([2, 4], false))
  expect(rows[1]).toMatchObject({ name: 'docs', is_private: 0, read_revision: 3 })
  expect(rows[2]).toMatchObject({ file_name: 'docs/a.txt', is_private: 0, read_revision: 3,
    redacted_avif_key: 'kept-avif', redacted_jpeg_key: 'kept-jpeg' })
  expect(rows[3]).toMatchObject({ file_name: 'docs/b.txt.good', is_private: 1, read_revision: 1 })
  expect(rows[5]).toMatchObject({ file_name: 'docs/nested/deep.txt', is_private: 0, read_revision: 3 })
  expect(rows[6]).toMatchObject({ file_name: 'docs/own.good', is_private: 1, read_revision: 1 })
  expect(rows[7]).toMatchObject({ file_name: 'docs/own.good/own.txt', is_private: 1, read_revision: 1 })
  expect(mocks.storage).not.toHaveBeenCalled()
})

it('handles a mixed folder/file privacy batch without processing selected descendants twice', async () => {
  Object.assign(rows[2]!, { parent_id: 2, file_name: 'docs/a.txt' })
  const report = await execute_workspace_command(7, command([2, 3, 4], true))
  expect(report.succeeded).toEqual(['docs.good', 'b.txt.good'])
  expect(rows[2]).toMatchObject({ file_name: 'docs.good/a.txt', name: 'a.txt', is_private: 1, read_revision: 2 })
  expect(rows[3]).toMatchObject({ file_name: 'b.txt.good', is_private: 1, read_revision: 2 })
})

it('resolves directory privacy name collisions before mutating any member of a batch', async () => {
  rows.push({ ... rows[1]!, id: 5, name: 'docs.good', name_key: 'docs.good', file_name: 'docs.good', is_private: 1 })
  await expect(execute_workspace_command(7, command([2, 4], true))).rejects.toMatchObject({ statusCode: 409,
    public_data: { details: { items: [expect.objectContaining({ category: 'name_conflict' })], valid_count: 1 } } })
  expect(updates()).toHaveLength(0)
  const retry = command([2], true)
  await execute_workspace_command(7, { ... retry, on_error: { ... retry.on_error, name_conflict: 'suffix' } })
  expect(rows[1]!.file_name).toBe('docs_1.good')
})

it('rejects a reserved directory privacy destination before changing the ACL', async () => {
  reservations.push({ id: 'reserved', target_parent_id: 1, target_path: 'docs.good', target_name_key: 'docs.good', intent: { target_name: 'docs.good' } })
  await expect(execute_workspace_command(7, command([2], true))).rejects.toMatchObject({ statusCode: 409,
    public_data: { details: { items: [expect.objectContaining({ category: 'reserved' })] } } })
  expect(updates()).toHaveLength(0)
})

it('does not cancel inherited directory privacy or let an unauthorized actor toggle a folder', async () => {
  Object.assign(rows[1]!, { name: 'docs.good', name_key: 'docs.good', file_name: 'docs.good', is_private: 1 })
  rows.push({ ... rows[1]!, id: 5, parent_id: 2, name: 'nested', name_key: 'nested', file_name: 'docs.good/nested' })
  await expect(execute_workspace_command(7, command([5], false))).rejects.toMatchObject({ statusCode: 409,
    public_data: { details: { items: [expect.objectContaining({ code: 'INHERITED_PRIVATE' })] } } })
  admin = false
  await expect(execute_workspace_command(7, command([2], false))).rejects.toMatchObject({ statusCode: 403 })
  expect(updates()).toHaveLength(0)
})

it('blocks the shared folder privacy command during a reserved child upload', async () => {
  reservations.push({ id: 'reserved', target_parent_id: 2, target_path: 'docs/new.txt', intent: { target_name: 'new.txt' } })
  await expect(execute_workspace_command(7, command([2], true))).rejects.toMatchObject({ statusCode: 409,
    public_data: { details: { items: [expect.objectContaining({ code: 'SOURCE_BUSY' })] } } })
  expect(updates()).toHaveLength(0)
})

it('creates a declared private directory with effective access and leaves a repeated rename unchanged', async () => {
  await execute_workspace_command(7, workspace_command_schema.parse({ operation: 'create_folder', request_id: crypto.randomUUID(), scope_id: 1, parent_id: 1, name: 'private.good' }))
  const node = rows.find(row => row.file_name === 'private.good')!
  expect(node).toMatchObject({ is_folder: 1, is_private: 1, node_revision: 1, read_revision: 1 })
  const version = node_version(rows, node)
  await execute_workspace_command(7, workspace_command_schema.parse({ operation: 'rename', request_id: crypto.randomUUID(), scope_id: 1, target: { id: node.id, version }, name: node.name }))
  expect(node_version(rows, node)).toBe(version)
  expect(updates()).toHaveLength(0)
})

it('requires private permission before creating a declared private directory', async () => {
  admin = false
  await expect(execute_workspace_command(7, workspace_command_schema.parse({ operation: 'create_folder', request_id: crypto.randomUUID(), scope_id: 1, parent_id: 1, name: 'private.good' })))
    .rejects.toMatchObject({ statusCode: 403 })
  expect(rows.some(row => row.file_name === 'private.good')).toBe(false)
})

it('recalculates descendants on directory ACL changes while retaining independent declarations', async () => {
  Object.assign(rows[2]!, { parent_id: 2, file_name: 'docs/a.txt' })
  Object.assign(rows[3]!, { parent_id: 2, name: 'b.txt.good', name_key: 'b.txt.good', file_name: 'docs/b.txt.good', is_private: 1 })
  const rename = (name: string) => workspace_command_schema.parse({ operation: 'rename', request_id: crypto.randomUUID(), scope_id: 1, name,
    target: { id: 2, version: node_version(rows, rows[1]!) } })
  await execute_workspace_command(7, rename('docs.good'))
  expect(rows[2]).toMatchObject({ file_name: 'docs.good/a.txt', is_private: 1, read_revision: 2, node_revision: 2 })
  expect(rows[3]).toMatchObject({ file_name: 'docs.good/b.txt.good', is_private: 1, read_revision: 1, node_revision: 1 })
  await execute_workspace_command(7, rename('docs'))
  expect(rows[2]).toMatchObject({ file_name: 'docs/a.txt', is_private: 0, read_revision: 3, node_revision: 3 })
  expect(rows[3]).toMatchObject({ file_name: 'docs/b.txt.good', is_private: 1, read_revision: 1 })
})

it('inherits destination access and releases it when a file moves out, without appending a leaf marker', async () => {
  Object.assign(rows[1]!, { name: 'docs.good', name_key: 'docs.good', file_name: 'docs.good' })
  const move = (parent_id: number) => workspace_command_schema.parse({ operation: 'move', request_id: crypto.randomUUID(), scope_id: 1, parent_id,
    targets: [{ id: 3, version: node_version(rows, rows[2]!) }] })
  await execute_workspace_command(7, move(2))
  expect(rows[2]).toMatchObject({ file_name: 'docs.good/a.txt', name: 'a.txt', is_private: 1, read_revision: 2 })
  await expect(execute_workspace_command(7, command([3], false))).rejects.toMatchObject({ statusCode: 409,
    public_data: { details: { items: [expect.objectContaining({ code: 'INHERITED_PRIVATE' })] } } })
  await execute_workspace_command(7, move(1))
  expect(rows[2]).toMatchObject({ file_name: 'a.txt', is_private: 0, read_revision: 3 })
})

it('requires private permission for a private destination, even when the source is public', async () => {
  admin = false
  Object.assign(rows[1]!, { name: 'docs.good', name_key: 'docs.good', file_name: 'docs.good' })
  const input = workspace_command_schema.parse({ operation: 'move', request_id: crypto.randomUUID(), scope_id: 1, parent_id: 2,
    targets: [{ id: 3, version: node_version(rows, rows[2]!) }] })
  await expect(execute_workspace_command(7, input)).rejects.toMatchObject({ statusCode: 403 })
  expect(updates()).toHaveLength(0)
})

it('blocks directory ACL changes during a reserved child upload', async () => {
  reservations.push({ id: 'reserved', target_parent_id: 2, target_path: 'docs/new.txt', intent: { target_name: 'new.txt' } })
  const input = workspace_command_schema.parse({ operation: 'rename', request_id: crypto.randomUUID(), scope_id: 1, name: 'docs.good', target: { id: 2, version: node_version(rows, rows[1]!) } })
  await expect(execute_workspace_command(7, input)).rejects.toMatchObject({ statusCode: 409,
    public_data: { details: { items: [expect.objectContaining({ code: 'SOURCE_BUSY' })] } } })
  expect(updates()).toHaveLength(0)
})

function redacted_command() {
  Object.assign(rows[3]!, { original_key: 'archive', avif_key: 'normal-avif', jpeg_key: 'normal-jpeg',
    redacted_avif_key: 'redacted-avif', redacted_jpeg_key: 'redacted-jpeg', redacted_revision: 2, redacted_metadata: { width: 20 }, redacted_lqip_jpeg: Buffer.from('preview') })
  return workspace_command_schema.parse({ operation: 'delete_redacted', scope_id: 1, request_id: crypto.randomUUID(),
    target: { id: 4, version: node_version(rows, rows[3]!) } })
}

it('deletes only the redacted pair, preserves the owner and archive, and replays without retiring twice', async () => {
  const input = redacted_command()
  const owner = structuredClone(rows[3]!)
  const report = await execute_workspace_command(7, input)
  expect(report.succeeded).toEqual(['b.txt'])
  expect(rows[3]).toMatchObject({ id: owner.id, file_name: owner.file_name, object_key: owner.object_key,
    original_key: 'archive', avif_key: 'normal-avif', jpeg_key: 'normal-jpeg', redacted_avif_key: null, redacted_jpeg_key: null,
    redacted_metadata: null, redacted_lqip_jpeg: null, redacted_revision: 3, read_revision: 2, node_revision: 2 })
  const retired = () => mocks.execute.mock.calls.filter(([sql]) => String(sql).startsWith('INSERT IGNORE INTO content_object_retirements'))
  expect(retired().map(([, args]) => args[0]).sort()).toEqual(['redacted-avif', 'redacted-jpeg'])
  expect(mocks.execute.mock.calls.some(([sql]) => String(sql).startsWith('DELETE FROM content_story_attachments'))).toBe(false)
  expect(resources()).toEqual(['content_attachments:1'])
  await expect(execute_workspace_command(7, input)).resolves.toEqual(report)
  expect(retired()).toHaveLength(2)
  expect(rows[3]!.redacted_revision).toBe(3)
})

it('requires private management permission to remove a retained variant even when its owner is public', async () => {
  const input = redacted_command()
  admin = false
  await expect(execute_workspace_command(7, input)).rejects.toMatchObject({ statusCode: 403 })
  expect(rows[3]!.redacted_avif_key).toBe('redacted-avif')
  expect(mocks.commit).not.toHaveBeenCalled()
  expect(resources()).toEqual([])
})

it('rejects an outdated variant deletion decision before changing pixels or retiring objects', async () => {
  const input = redacted_command()
  rows[3]!.node_revision ++
  await expect(execute_workspace_command(7, input)).rejects.toMatchObject({ statusCode: 409,
    public_data: { details: { items: [expect.objectContaining({ code: 'SOURCE_CHANGED' })] } } })
  expect(rows[3]!.redacted_avif_key).toBe('redacted-avif')
  // Rejected commands persist their error receipt, but no attachment mutation.
  expect(mocks.execute.mock.calls.some(([sql]) => String(sql).startsWith('UPDATE content_story_attachments'))).toBe(false)
  expect(mocks.execute.mock.calls.some(([sql]) => String(sql).startsWith('INSERT IGNORE INTO content_object_retirements'))).toBe(false)
  expect(resources()).toEqual([])
})

it.each([
  ['a.txt', 'renamed.pdf'],
  ['a.txt', 'renamed'],
  ['a.txt', 'renamed.txt.exe'],
  ['README', 'renamed.txt'],
  ['a.txt.good', 'renamed.pdf'],
  ['a.txt', 'renamed.pdf', 'sanitize'],
  ['a.TXT', 'new:Name.TXT', 'sanitize'],
])('rejects extension changes from %s to %s even for direct rename requests', async (original, name, policy = 'fail') => {
  Object.assign(rows[3]!, { name: original, file_name: original, name_key: original.toLowerCase(), is_private: original.endsWith('.good') ? 1 : 0 })
  const input = workspace_command_schema.parse({ operation: 'rename', scope_id: 1, request_id: crypto.randomUUID(), name,
    target: { id: 4, version: node_version(rows, rows[3]!) }, on_error: { invalid_name: policy } })
  await expect(execute_workspace_command(7, input)).rejects.toMatchObject({ statusCode: 409, public_data: { code: 'BATCH_REJECTED', details: { items: [expect.objectContaining({ code: 'EXTENSION_LOCKED', allowed: ['fail', 'skip'] })] } } })
  expect(updates()).toHaveLength(0)
  expect(resources()).toEqual([])
})

it.each([
  ['a.txt', 'New.Name.txt', 'New.Name.txt'],
  ['a.txt.good', 'New.Name.txt', 'New.Name.txt.good'],
  ['README', 'NEW_README', 'NEW_README'],
  ['a.JPG', 'New.JPG', 'New.JPG'],
])('renames %s while preserving its extension and privacy marker', async (original, name, expected) => {
  Object.assign(rows[3]!, { name: original, file_name: original, name_key: original.toLowerCase(), is_private: original.endsWith('.good') ? 1 : 0 })
  await execute_workspace_command(7, workspace_command_schema.parse({ operation: 'rename', scope_id: 1, request_id: crypto.randomUUID(), name,
    target: { id: 4, version: node_version(rows, rows[3]!) } }))
  expect(rows[3]!.file_name).toBe(expected)
})

it('allows dotted folder names without imposing a file extension', async () => {
  await execute_workspace_command(7, workspace_command_schema.parse({ operation: 'rename', scope_id: 1, request_id: crypto.randomUUID(), name: 'Folder.JPG',
    target: { id: 2, version: node_version(rows, rows[1]!) } }))
  expect(rows[1]!.file_name).toBe('Folder.JPG')
})

it('commits deletion and its retirement without depending on a post-commit cleanup query', async () => {
  const execute = mocks.execute.getMockImplementation()!
  mocks.execute.mockImplementation(async (sql: string, args: unknown[] = []) => {
    if (sql.includes('COUNT(*) AS pending'))
      throw new Error('cleanup status unavailable')
    return execute(sql, args)
  })
  const input = workspace_command_schema.parse({ operation: 'delete', scope_id: 1, request_id: crypto.randomUUID(),
    targets: [{ id: 4, version: node_version(rows, rows[3]!) }] })
  const result = await execute_workspace_command(7, input)
  expect(result).toMatchObject({ succeeded: ['b.txt'], skipped: [], renamed: [] })
  expect(result).not.toHaveProperty('cleanup_pending')
  expect(mocks.commit).toHaveBeenCalledOnce()
  expect(mocks.execute.mock.calls.some(([sql]) => String(sql).startsWith('INSERT IGNORE INTO content_object_retirements'))).toBe(true)
  expect(mocks.execute.mock.calls.some(([sql]) => String(sql).startsWith('DELETE FROM content_story_attachments'))).toBe(true)
  await expect(execute_workspace_command(7, input)).resolves.toEqual(result)
  expect(mocks.execute.mock.calls.filter(([sql]) => String(sql).startsWith('INSERT IGNORE INTO content_object_retirements'))).toHaveLength(1)
})

it.each(['[label][f]', '[f][]', '[f]', '![f]'])('deletes a referenced target while preserving the saved definition: %s', async (usage) => {
  story.markdown = `${usage}\n\n[f]: att://b.txt`
  const input = workspace_command_schema.parse({ operation: 'delete', scope_id: 1, request_id: crypto.randomUUID(),
    targets: [{ id: 4, version: node_version(rows, rows[3]!) }] })
  await expect(execute_workspace_command(7, input)).resolves.toMatchObject({ succeeded: ['b.txt'] })
  expect(rows.some(row => row.id === 4)).toBe(false)
  expect(story.markdown).toBe(`${usage}\n\n[f]: att://b.txt`)
  expect(mocks.execute.mock.calls.some(([sql]) => String(sql).startsWith('INSERT IGNORE INTO content_object_retirements'))).toBe(true)
  expect(resources()).toContain('content_attachments:1')
})

it('rewrites a saved definition on rename and enqueues document and list refresh', async () => {
  story.markdown = '[f]\n\n[f]: att://b.txt "keep"'
  await execute_workspace_command(7, workspace_command_schema.parse({ operation: 'rename', scope_id: 1, request_id: crypto.randomUUID(), name: 'c.txt',
    target: { id: 4, version: node_version(rows, rows[3]!) } }))
  const writes = mocks.execute.mock.calls.filter(([sql]) => String(sql).startsWith('UPDATE content_stories SET'))
  expect(writes.some(([, args]) => args.includes('[f]\n\n[f]: att://c.txt "keep"'))).toBe(true)
  expect(resources()).toEqual(['content_attachments:1', 'content_stories:all', 'content_story:1'])
})

it('declassifies a nested file and rewrites default labels in main, cloud draft and cover while preserving captions', async () => {
  Object.assign(rows[3]!, { parent_id: 2, name: 'b.txt.good', name_key: 'b.txt.good', file_name: 'docs/b.txt.good', is_private: 1 })
  story.cover = 'docs/b.txt.good'
  story.markdown = '---\ncover: ![b.txt.good](att://DOCS/B.TXT.GOOD)\n---\n![b.txt.good](att://docs/b.txt.good) [说明][p]\n\n[p]: att://docs/b.txt.good'
  const draft = { id: 'd'.repeat(32), story_id: 1, markdown: `${story.markdown}\n未发布文字`, namespace_revision: 1, title_revision: 0, draft_revision: 3 }
  const execute = mocks.execute.getMockImplementation()!
  mocks.execute.mockImplementation(async (sql: string, args: unknown[] = []) => {
    if (sql.includes('FROM content_story_drafts'))
      return [[{ ... draft }]]
    if (sql.startsWith('UPDATE content_story_drafts SET markdown')) {
      Object.assign(draft, { markdown: String(args[0]), namespace_revision: Number(args[1]), draft_revision: draft.draft_revision + 1 })
      return [{ affectedRows: 1 }]
    }
    if (sql.startsWith('UPDATE content_stories SET markdown'))
      Object.assign(story, { markdown: String(args[0]), cover: String(args[1]), cover_version: args[2] })
    return execute(sql, args)
  })
  const input = command([4], false)
  await execute_workspace_command(7, input)
  expect(rows[3]).toMatchObject({ name: 'b.txt', file_name: 'docs/b.txt', is_private: 0, node_revision: 2, read_revision: 2 })
  expect(story.cover).toBe('docs/b.txt')
  expect(story.markdown).toBe('---\ncover: ![b.txt](att://docs/b.txt)\n---\n![b.txt](att://docs/b.txt) [说明][p]\n\n[p]: att://docs/b.txt')
  expect(draft).toMatchObject({ markdown: `${story.markdown}\n未发布文字`, namespace_revision: 2, draft_revision: 4 })
  expect(resources()).toEqual(['content_attachments:1', wire_resource(`content_draft:${draft.id}`), 'content_stories:all', 'content_story:1'].sort())
  await execute_workspace_command(7, input)
  expect(rows[3]!.read_revision).toBe(2)
  expect(draft.draft_revision).toBe(4)
})

it('revokes old read grants on both privacy transitions but not no-ops or receipt replay', async () => {
  const input = command([4], true)
  await execute_workspace_command(7, input)
  expect(rows.find(row => row.id === 4)!.read_revision).toBe(2)
  await execute_workspace_command(7, input)
  await execute_workspace_command(7, command([4], true))
  expect(rows.find(row => row.id === 4)!.read_revision).toBe(2)
  await execute_workspace_command(7, command([4], false))
  expect(rows.find(row => row.id === 4)!.read_revision).toBe(3)
})

it.each([
  { operation: 'rename', folder: false, private: false },
  { operation: 'rename', folder: true, private: false },
  { operation: 'move', folder: false, private: false },
  { operation: 'move', folder: true, private: false },
  { operation: 'set_private', folder: false, private: false },
  { operation: 'set_private', folder: false, private: true },
  { operation: 'set_private', folder: true, private: false },
  { operation: 'set_private', folder: true, private: true },
])('keeps an unchanged $operation target stable (folder=$folder, private=$private), including replay', async ({ operation, folder, private: private_value }) => {
  const node = rows.find(row => row.id === (folder ? 2 : 4))!
  if (private_value) {
    const name = folder ? 'docs.good' : 'b.txt.good'
    Object.assign(node, { is_private: 1, name, name_key: name, file_name: name })
  }
  const before = structuredClone(rows)
  const target = { id: node.id, version: node_version(rows, node) }
  const input = workspace_command_schema.parse({ scope_id: 1, request_id: crypto.randomUUID(), operation,
    ... (operation === 'rename' ? { target, name: node.name } : { targets: [target], ... (operation === 'move' ? { parent_id: 1 } : { private: private_value }) }),
  })
  expect(await execute_workspace_command(7, input)).toMatchObject({ succeeded: [node.file_name] })
  expect(rows).toEqual(before)
  expect(updates()).toHaveLength(0)
  expect(mocks.execute.mock.calls.some(([sql]) => String(sql).startsWith('UPDATE content_stories'))).toBe(false)
  expect(JSON.parse(receipts.get(input.request_id)!.result).value.refresh).toEqual({})
  expect(resources()).toEqual([])
  await execute_workspace_command(7, input)
  expect(rows).toEqual(before)
  expect(resources()).toEqual([])
})

it('still refreshes committed session expiry when the requested attachment is unchanged', async () => {
  expired = [{ id: 'e'.repeat(32) }]
  await execute_workspace_command(7, command([4], false))
  expect(updates()).toHaveLength(0)
  expect(resources()).toEqual([`content_upload_session:${expired[0]!.id}`, 'content_uploads:1'])
})

it('refreshes only the namespace for an unreferenced attachment, including receipt replay', async () => {
  const input = command([4], true)
  const result = await execute_workspace_command(7, input)
  expect(resources()).toEqual(['content_attachments:1'])
  expect(result).not.toHaveProperty('refresh')
  mocks.refresh.mockClear()
  await execute_workspace_command(7, input)
  expect(resources()).toEqual(['content_attachments:1'])
  expect(updates()).toHaveLength(1)
})

it('refreshes the list as well as the document when saved references or a cover change', async () => {
  story.cover = 'b.txt'
  story.cover_version = 'v1'
  await execute_workspace_command(7, command([4], true))
  expect(resources()).toEqual(['content_attachments:1', 'content_stories:all', 'content_story:1'])
  mocks.refresh.mockClear()
  await execute_workspace_command(7, command([3], true))
  expect(resources()).toEqual(['content_attachments:1', 'content_stories:all', 'content_story:1'])
})

it('refreshes only sessions whose reserved target moved with a directory', async () => {
  reservations = [{ id: 'upload', target_parent_id: 2, target_path: 'docs/new.txt', intent: { target_name: 'new.txt' } }]
  await execute_workspace_command(7, workspace_command_schema.parse({ operation: 'rename', scope_id: 1, request_id: crypto.randomUUID(), name: 'renamed',
    target: { id: 2, version: node_version(rows, rows[1]!) } }))
  expect(resources()).toEqual(['content_attachments:1', 'content_upload_session:upload', 'content_uploads:1'])
})

it('replays legacy receipts conservatively without reapplying their business effects', async () => {
  const input = command([4], true)
  await execute_workspace_command(7, input)
  const receipt = receipts.get(input.request_id)!
  const stored = JSON.parse(receipt.result)
  delete stored.value.refresh
  receipt.result = JSON.stringify(stored)
  mocks.refresh.mockClear()
  await execute_workspace_command(7, input)
  expect(resources()).toEqual(['content_attachments:1', 'content_stories:all', 'content_story:1', 'content_uploads:1'])
  expect(updates()).toHaveLength(1)
})

it('does not notify after a failed commit', async () => {
  mocks.commit.mockRejectedValueOnce(new Error('commit failed'))
  await expect(execute_workspace_command(7, command([3], true))).rejects.toThrow('commit failed')
  expect(mocks.refresh).not.toHaveBeenCalled()
})

it('includes committed expiry cleanup in the receipt even if the requested targets are skipped', async () => {
  expired = [{ id: 'e'.repeat(32) }]
  const input = command([4], true)
  input.targets[0]!.version = 'stale'
  input.on_error.other = 'skip'
  const result = await execute_workspace_command(7, input)
  expect(result.succeeded).toEqual([])
  expect(resources()).toEqual([`content_upload_session:${expired[0]!.id}`, 'content_uploads:1'])
  mocks.refresh.mockClear()
  await execute_workspace_command(7, input)
  expect(resources()).toEqual([`content_upload_session:${expired[0]!.id}`, 'content_uploads:1'])
})

it('sets and clears privacy for every target in one transaction, and replays without applying twice', async () => {
  const input = command([3, 4], true)
  const result = await execute_workspace_command(7, input)
  expect(result.succeeded).toEqual(['a.txt.good', 'b.txt.good'])
  expect(rows.filter(row => ! row.is_folder).map(row => row.is_private)).toEqual([1, 1])
  expect(updates()).toHaveLength(2)
  expect(mocks.commit).toHaveBeenCalledOnce()
  expect(mocks.execute.mock.calls.find(([sql]) => String(sql).startsWith('UPDATE content_stories SET markdown'))?.[1]).toEqual(expect.arrayContaining(['[a](att://a.txt.good)']))
  await execute_workspace_command(7, input)
  expect(updates()).toHaveLength(2)
  const cleared = await execute_workspace_command(7, command([3, 4], false))
  expect(cleared.succeeded).toEqual(['a.txt', 'b.txt'])
  expect(rows.filter(row => ! row.is_folder).map(row => row.is_private)).toEqual([0, 0])
  expect(mocks.storage).not.toHaveBeenCalled()
  expect(mocks.refresh).toHaveBeenCalled()
})

it('rejects a batch containing the workspace root without changing its valid files', async () => {
  await expect(execute_workspace_command(7, command([1, 3], true))).rejects.toMatchObject({ statusCode: 409, public_data: { code: 'BATCH_REJECTED', details: { items: [expect.objectContaining({ code: 'NOT_FOUND' })] } } })
  expect(updates()).toHaveLength(0)
  expect(mocks.query).toHaveBeenCalledWith('ROLLBACK TO SAVEPOINT workspace_effects')
  expect(mocks.refresh).not.toHaveBeenCalled()
})

it('rejects stale versions for the whole batch', async () => {
  const input = command([3, 4], true)
  input.targets[1]!.version = 'stale'
  await expect(execute_workspace_command(7, input)).rejects.toMatchObject({ statusCode: 409, public_data: { code: 'BATCH_REJECTED', details: { items: [expect.objectContaining({ code: 'SOURCE_CHANGED' })] } } })
  expect(updates()).toHaveLength(0)
})

it('requires private permission before modifying any file', async () => {
  admin = false
  await expect(execute_workspace_command(7, command([3, 4], true))).rejects.toMatchObject({ statusCode: 403 })
  expect(updates()).toHaveLength(0)
  expect(mocks.rollback).toHaveBeenCalledOnce()
})
