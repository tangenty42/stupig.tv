import type { UploadRow } from './upload-session.repository'
import type { WorkspaceRow } from './workspace.repository'
import { upload_batch_schema, upload_content_mime } from '@shared/content-upload'
import { beforeEach, expect, it, vi } from 'vitest'

const boundary = vi.hoisted(() => ({ execute: vi.fn(), commit: vi.fn(), rollback: vi.fn(), publish: vi.fn(), storage: vi.fn() }))
const preload_fixture = vi.hoisted(() => ({ enabled: false }))
vi.mock('@server/lib/db', () => ({ db: { execute: boundary.execute, getConnection: async () => ({
  execute: boundary.execute, query: vi.fn(), beginTransaction: vi.fn(), commit: boundary.commit, rollback: boundary.rollback, release: vi.fn(),
}) } }))
vi.mock('@server/lib/sync', () => ({ publish_refresh: boundary.publish, sync_resource: (type: string, id: unknown) => `${type}:${id}` }))
vi.mock('@server/lib/aliyun-oss', () => ({ create_aliyun_oss: boundary.storage }))
vi.mock('@config/loader', () => ({ runtime_config: () => ({ aliyun: { oss: { bucket: 'test', endpoint: 'https://example.test', region: 'test' },
  esa: { baseUrl: 'https://edge.example.test' }, esaPurge: { siteId: '123' } }, app: {
  contentPreload: { get enabled() { return preload_fixture.enabled }, maxObjectBytes: 1000 },
  contentImages: { enabled: true, leaseSeconds: 60, heartbeatSeconds: 10, scanLimit: 10, concurrency: 1 },
} }) }))

// Exercise admission/publication through the real API and receipt/namespace services.
// Only SQL, storage and sync boundaries are substituted; no cloud data is touched.
const { begin_upload_batch, adopt_upload_session, list_upload_sessions, sweep_content_images } = await import('./upload-api.service')
const { node_version } = await import('./workspace.repository')
let rows: WorkspaceRow[]
let story: { cover: string, cover_version: string | null, markdown: string, namespace_revision: number }
let session: UploadRow
let admin: boolean
let receipts: Map<string, { fingerprint: string, result: string }>
const session_id = 'a'.repeat(32)
const resources = () => boundary.publish.mock.calls.map(([event]) => event.resource).sort()

beforeEach(() => {
  preload_fixture.enabled = false
  vi.clearAllMocks()
  admin = true
  // Delivery is tested by the dispatcher; these are committed notification duties.
  let pending: object[] = []
  boundary.commit.mockImplementation(async () => {
    pending.forEach(event => boundary.publish(event))
    pending = []
  })
  boundary.rollback.mockImplementation(async () => {
    pending = []
  })
  receipts = new Map()
  const root = { id: 1, story_id: 1, parent_id: 0, name: '', name_key: '', file_name: '', is_folder: 1, node_revision: 1,
    object_key: null, version: '', is_private: 0, storage_bucket: 'private', storage_provider: 'aliyun', encryption_key: null, file_size: 0, mime_type: null, oss_version_id: null }
  rows = [root, { ... root, id: 2, parent_id: 1, name: 'existing.txt', name_key: 'existing.txt', file_name: 'existing.txt', is_folder: 0,
    object_key: 'old-key', version: 'v1', file_size: 10 }] as WorkspaceRow[]
  story = { cover: '', cover_version: null, markdown: 'unchanged', namespace_revision: 1 }
  session = { id: session_id, actor_id: 7, scope_id: 1, status: 'verifying', remaining_seconds: 3600, expected_size: 10,
    active_attempt_id: 'b'.repeat(32), revision: 1, execution_epoch: 1, busy: 0,
    result: { key: 'new-key', etag: 'v2', oss_version_id: 'oss-v2', size: 10, sha256: 'c'.repeat(64) },
    intent: { scope_id: 1, operation: 'upload', target_path: 'new.txt', target_name: 'new.txt', target_parent_id: 1,
      target_location: 'aliyun', target_access: 'public', expected_size: 10, sha256: 'c'.repeat(64), purpose: 'create' },
  } as UploadRow
  boundary.execute.mockImplementation(async (sql: string, args: unknown[] = []) => {
    if (sql.includes('FROM content_story_drafts'))
      return [[]]
    if (sql.startsWith('INSERT INTO content_sync_outbox'))
      pending.push(JSON.parse(String(args[2])))
    if (sql.startsWith('SELECT 1') || sql.includes('FROM content_object_retirements') || sql.includes('FROM content_upload_images'))
      return [[]]
    if (sql.includes('FROM users'))
      return [[{ id: 7, is_admin: admin, is_banned: 0, permissions: admin ? [] : [{ field: 'content_manage', level: 'full' }] }]]
    if (sql.includes('FROM content_command_receipts'))
      return [receipts.has(String(args[1])) ? [receipts.get(String(args[1]))] : []]
    if (sql.startsWith('INSERT INTO content_command_receipts'))
      receipts.set(String(args[1]), { fingerprint: String(args[3]), result: String(args[4]) })
    if (sql.includes('FROM content_stories'))
      return [[{ id: 1, ... story }]]
    if (sql.includes('FROM content_story_attachments')) {
      if (sql.includes('parent_id = ? AND name_key = ?'))
        return [structuredClone(rows.filter(row => row.parent_id === args[1] && row.name_key === args[2]))]
      if (sql.includes('AND id = ?'))
        return [structuredClone(rows.filter(row => row.id === args[1]))]
      if (sql.includes('is_folder = 0'))
        return [structuredClone(rows.filter(row => ! row.is_folder))]
      return [structuredClone(rows)]
    }
    if (sql.startsWith('INSERT INTO content_story_attachments')) {
      const id = rows.length + 1
      rows.push({ ... root, id, parent_id: Number(args[1]), name: String(args[2]), name_key: String(args[3]), file_name: String(args[4]),
        ... (sql.includes('object_key')
          ? { is_folder: 0, object_key: String(args[5]), mime_type: String(args[6]), file_size: Number(args[7]),
              version: String(args[8]), oss_version_id: String(args[9]), is_private: Number(args[10]) }
          : { is_private: Number(args[5] ?? 0) }) } as WorkspaceRow)
      return [{ insertId: id, affectedRows: 1 }]
    }
    if (sql.startsWith('UPDATE content_story_attachments SET parent_id')) {
      Object.assign(rows.find(row => row.id === args[10])!, { parent_id: args[0], name: args[1], name_key: args[2], file_name: args[3],
        object_key: args[4], mime_type: args[5], file_size: args[6], version: args[7], oss_version_id: args[8], is_private: args[9], node_revision: 2,
        original_key: null, avif_key: null, jpeg_key: null, parent_avif_key: null, image_metadata: null, lqip_jpeg: null, is_edited: 0 })
    }
    if (sql.startsWith('UPDATE content_stories SET markdown'))
      Object.assign(story, { markdown: args[0], cover: args[1], cover_version: args[2] })
    if (sql.startsWith('UPDATE content_stories SET namespace_revision'))
      story.namespace_revision ++
    if (sql.startsWith('INSERT INTO content_transfer_sessions')) {
      session = { ... session, id: String(args[0]), fingerprint: String(args[3]), intent: JSON.parse(String(args[6])), result: null, status: 'queued', active_attempt_id: null }
    }
    if (sql.startsWith('UPDATE content_transfer_sessions SET status'))
      Object.assign(session, { status: 'completed', result: JSON.parse(String(args[0])) })
    if (sql.includes('FROM content_transfer_sessions')) {
      if (sql.includes('expires_at > CURRENT_TIMESTAMP') || (sql.includes('expires_at <= CURRENT_TIMESTAMP') && ! sql.includes('AS expired')))
        return [[]]
      return [[structuredClone(session)]]
    }
    if (sql.includes('FROM content_transfer_attempts'))
      return [[{ id: session.active_attempt_id, target_key: 'new-key', cleanup_required: 0, upload_id: 'multipart', part_size: 262144 }]]
    if (sql.includes('FROM content_transfer_parts'))
      return [[]]
    return [{ affectedRows: 1 }]
  })
})

it('enqueues a published raw GIF through the real upload adopter without warming a staging input', async () => {
  preload_fixture.enabled = true
  const result = await begin_upload_batch(7, upload_batch_schema.parse({ scope_id: 1, request_id: crypto.randomUUID(),
    entries: [{ path: 'raw.gif', size: 10, sha256: 'c'.repeat(64) }] }))
  session.status = 'verifying'
  session.result = { key: 'content/att/raw-gif', etag: 'etag', oss_version_id: 'oss-version', size: 10, sha256: 'c'.repeat(64) }
  const published = await adopt_upload_session(result.accepted[0]!.session_id, 7)
  const queued = boundary.execute.mock.calls.filter(([sql]) => sql.startsWith('INSERT IGNORE INTO content_preload_jobs'))
  expect(queued).toHaveLength(1)
  expect(queued[0]![1].slice(1)).toEqual([1, published.attachment_id, 'content/att/raw-gif'])
})

it.each([
  ['Photo.PNG.good', undefined, 'Photo.png.good', 'image/png', true],
  ['Animation.GIF.GOOD', undefined, 'Animation.gif.good', 'image/gif', false],
  ['photos.good/sub/Vector.SVG', 'photos.good', 'photos.good/sub/Vector.svg', 'image/svg+xml', false],
  ['photos/nested.good/Scan.TIFF', 'photos', 'photos/nested.good/Scan.tiff', 'image/tiff', false],
])('admits the direct or inherited declaration on %s without duplicating the marker', async (path, selection_root, expected, mime, processed) => {
  const result = await begin_upload_batch(7, upload_batch_schema.parse({ scope_id: 1, request_id: crypto.randomUUID(),
    entries: [{ path, selection_root, original_name: path.split('/').at(- 1), size: 10, sha256: 'c'.repeat(64) }] }))
  expect(result.accepted).toMatchObject([{ path: expected }])
  expect(session.intent).toMatchObject({ target_path: expected, target_access: 'private', mime_type: mime })
  expect(Boolean(session.intent.image)).toBe(processed)
  if (selection_root) {
    const private_folders = rows.filter(row => row.is_folder && row.file_name.includes('.good'))
    expect(private_folders.length).toBeGreaterThan(0)
    expect(private_folders.every(row => Boolean(row.is_private))).toBe(true)
  }
  if (processed)
    return
  session.status = 'verifying'
  session.result = { key: 'raw-private-bytes', etag: 'etag', oss_version_id: 'oss-version', size: 10, sha256: 'c'.repeat(64) }
  const published = await adopt_upload_session(result.accepted[0]!.session_id, 7)
  expect(published.attachment).toMatchObject({ file_name: expected, is_private: true, mime_type: mime })
  expect(rows.find(row => row.id === published.attachment_id)).toMatchObject({ is_private: 1, object_key: 'raw-private-bytes' })
})

it.each([false, true])('keeps mixed upload access separate for multi-file and folder selection (folder=%s)', async (folder) => {
  const paths = folder
    ? ['album/public.txt', 'album/private.good/sub/a.txt', 'album/private.good/sub/b.txt', 'album/solo.txt.good']
    : ['public.txt', 'solo.txt.good', 'second.GIF.good']
  const result = await begin_upload_batch(7, upload_batch_schema.parse({ scope_id: 1, request_id: crypto.randomUUID(), entries: paths.map(path => ({
    path, ... (folder ? { selection_root: 'album' } : {}), size: 10, sha256: 'c'.repeat(64),
  })) }))
  const intents = boundary.execute.mock.calls.filter(([sql]) => sql.startsWith('INSERT INTO content_transfer_sessions')).map(([, args]) => JSON.parse(String(args[6])))
  expect(intents.map(intent => [intent.target_path, intent.target_access])).toEqual(paths.map((path, index) => [path.replace('.GIF', '.gif'), index ? 'private' : 'public']))
  expect(result.accepted).toHaveLength(paths.length)
})

it.each(['solo.txt.good', 'private.good/sub/a.txt'])('rejects %s without private permission before accepting any transfer', async (path) => {
  admin = false
  await expect(begin_upload_batch(7, upload_batch_schema.parse({ scope_id: 1, request_id: crypto.randomUUID(), entries: [{ path, size: 10, sha256: 'c'.repeat(64) }] })))
    .rejects.toMatchObject({ statusCode: 403 })
  expect(boundary.execute.mock.calls.some(([sql]) => sql.startsWith('INSERT INTO content_transfer_sessions'))).toBe(false)
})

it('preserves a private folder declaration when resolving a whole-folder collision', async () => {
  rows.push({ ... rows[0]!, id: 3, parent_id: 1, name: 'photos.good', name_key: 'photos.good', file_name: 'photos.good' })
  const result = await begin_upload_batch(7, upload_batch_schema.parse({ scope_id: 1, request_id: crypto.randomUUID(), on_error: { name_conflict: 'suffix' },
    entries: ['a.txt', 'sub/b.txt'].map(name => ({ path: `photos.good/${name}`, selection_root: 'photos.good', size: 10, sha256: 'c'.repeat(64) })) }))
  expect(result.accepted.map(item => item.path)).toEqual(['photos_1.good/a.txt', 'photos_1.good/sub/b.txt'])
  expect(session.intent.target_access).toBe('private')
})

it.each([true, false])('rechecks privacy after sanitizing a name into an ACL declaration (permission=%s)', async (allowed) => {
  admin = allowed
  const input = upload_batch_schema.parse({ scope_id: 1, request_id: crypto.randomUUID(), on_error: { invalid_name: 'sanitize' },
    entries: [{ path: 'secret.good.', size: 10, sha256: 'c'.repeat(64) }] })
  if (! allowed) {
    await expect(begin_upload_batch(7, input)).rejects.toMatchObject({ statusCode: 403 })
    expect(boundary.execute.mock.calls.some(([sql]) => sql.startsWith('INSERT INTO content_transfer_sessions'))).toBe(false)
  }
  else {
    await begin_upload_batch(7, input)
    expect(session.intent).toMatchObject({ target_path: 'secret.good', target_access: 'private' })
  }
})

it('refuses publication if a parent acquired private access after admission', async () => {
  rows.push({ ... rows[0]!, id: 3, parent_id: 1, name: 'private.good', name_key: 'private.good', file_name: 'private.good' })
  session.intent.target_parent_id = 3
  session.intent.target_path = 'formerly-public/new.txt'
  await expect(adopt_upload_session(session_id, 7)).rejects.toMatchObject({ statusCode: 409 })
  expect(rows.some(row => row.object_key === 'new-key')).toBe(false)
})

it.each(['keep', 'discard'] as const)('requires explicit %s resolution before admitting an overwrite with a redacted version', async (choice) => {
  Object.assign(rows[1]!, { avif_key: 'source.avif', jpeg_key: 'source.jpg', image_revision: 1,
    redacted_avif_key: 'redacted.avif', redacted_jpeg_key: 'redacted.jpg', redacted_revision: 1 })
  const input = upload_batch_schema.parse({ scope_id: 1, request_id: crypto.randomUUID(), entries: [{
    path: 'existing.txt', purpose: 'replace', source: { id: 2, version: node_version(rows, rows[1]!) },
    original_name: 'replacement.gif', content_type: 'image/gif', size: 10, sha256: 'c'.repeat(64),
  }] })
  await expect(begin_upload_batch(7, input)).rejects.toMatchObject({ statusCode: 409, public_data: { details: { items: [expect.objectContaining({ category: 'redacted', code: 'REDACTED_EXISTS' })] } } })
  expect(boundary.execute.mock.calls.some(([sql]) => sql.startsWith('INSERT INTO content_transfer_sessions'))).toBe(false)
  await begin_upload_batch(7, { ... input, request_id: crypto.randomUUID(), on_error: { ... input.on_error, redacted: choice } })
  expect(session.intent.redacted_policy).toBe(choice)
})

it.each([
  ['Animation.GIF', 'image/gif', 'public'],
  ['Vector.SVG', 'image/svg+xml', 'public'],
  ['Icon.ICO', '', 'public'],
  ['Scan.TIFF', 'image/tiff', 'public'],
  ['Picture.weird', 'image/x-other', 'public'],
  ['Secret.GIF', 'image/gif', 'private'],
])('admits and publishes %s as unchanged original bytes without an image job', async (original, mime, access) => {
  const result = await begin_upload_batch(7, upload_batch_schema.parse({ scope_id: 1, request_id: crypto.randomUUID(),
    entries: [{ path: original, original_name: original, content_type: mime, access, size: 10, sha256: 'c'.repeat(64) }] }))
  expect(session.intent.image).toBeUndefined()
  expect(session.intent.sha256).toBe('c'.repeat(64))
  session.status = 'verifying'
  session.result = { key: 'original-bytes', etag: 'original-etag', oss_version_id: 'original-version', size: 10, sha256: 'c'.repeat(64) }
  const published = await adopt_upload_session(result.accepted[0]!.session_id, 7)
  expect(published).toHaveProperty('workspace.namespace_revision', story.namespace_revision)
  expect(published).toHaveProperty('workspace.viewer_key', '7:true')
  expect(published.workspace.nodes?.find(node => node.id === published.attachment_id)?.attachment).toEqual(published.attachment)
  expect(published.attachment).toMatchObject({ mime_type: mime || 'image/x-icon', is_image: true, is_private: access === 'private', file_size: 10 })
  expect(published.attachment?.image).toBeUndefined()
  expect(rows.find(row => row.id === published.attachment_id)?.object_key).toBe('original-bytes')
  expect(boundary.execute.mock.calls.some(([sql]) => sql.startsWith('INSERT IGNORE INTO content_image_jobs'))).toBe(false)
})

it.each([
  ['image/jpeg', 'Selected.GIF', 'image/gif'],
  ['image/gif', 'Selected.PNG', 'image/png'],
  ['', 'Selected.AVIF', 'image/avif'],
  ['', 'Selected.PNG', 'image/png'],
])('uses the selected %s file rather than a replacement target suffix', async (declared, original, expected) => {
  const result = await begin_upload_batch(7, upload_batch_schema.parse({ scope_id: 1, request_id: crypto.randomUUID(),
    entries: [{ path: 'Retained.GIF', original_name: original, content_type: declared, size: 10, sha256: 'c'.repeat(64) }] }))
  const mime = declared || expected
  expect(result.accepted).toHaveLength(1)
  expect(session.intent.mime_type).toBe(mime)
  // Explicit MIME wins; the retained logical name is never another signal.
  expect(!! session.intent.image).toBe(mime !== 'image/gif')
})

it.each([
  ['copy.jpg', 'INVALID_IMAGE_COPY_NAME'], ['copy', 'INVALID_IMAGE_COPY_NAME'],
  ['.avif', 'INVALID_NAME'], ['copy.svg', 'INVALID_IMAGE_COPY_NAME'],
])('rejects an edited copy target without a fixed AVIF extension: %s', async (path, code) => {
  Object.assign(rows[1]!, { avif_key: 'source.avif', jpeg_key: 'source.jpg', image_revision: 1 })
  const source = { id: 2, version: node_version(rows, rows[1]!) }
  await expect(begin_upload_batch(7, upload_batch_schema.parse({ scope_id: 1, request_id: crypto.randomUUID(),
    entries: [{ path, original_name: 'edited.png', content_type: 'image/png', image_mode: 'copy', source, size: 10, sha256: 'c'.repeat(64) }] })))
    .rejects.toMatchObject({ statusCode: 409, public_data: { details: { items: [expect.objectContaining({ code })] } } })
  expect(boundary.execute.mock.calls.some(([sql]) => sql.startsWith('INSERT INTO content_transfer_sessions'))).toBe(false)
})

it('admits an edited AVIF copy while retaining PNG as its temporary pixel input', async () => {
  Object.assign(rows[1]!, { avif_key: 'source.avif', jpeg_key: 'source.jpg', image_revision: 1 })
  const source = { id: 2, version: node_version(rows, rows[1]!) }
  const result = await begin_upload_batch(7, upload_batch_schema.parse({ scope_id: 1, request_id: crypto.randomUUID(),
    entries: [{ path: '副本.AVIF', original_name: 'edited.png', content_type: 'image/png', image_mode: 'copy', source, size: 10, sha256: 'c'.repeat(64) }] }))
  expect(result.accepted[0]?.path).toBe('副本.avif')
  expect(session.intent.image).toMatchObject({ mode: 'copy', original_mime: 'image/png', original_name: 'edited.png' })
})

it('normalizes the selected MIME and falls back to its original extension for invalid or generic declarations', () => {
  expect(upload_content_mime({ path: 'kept.jpg', original_name: 'new.SVG', content_type: 'IMAGE/SVG+XML; charset=utf-8' })).toBe('image/svg+xml')
  expect(upload_content_mime({ path: 'kept.jpg', original_name: 'new.GIF', content_type: 'application/octet-stream' })).toBe('image/gif')
  expect(upload_content_mime({ path: 'kept.jpg', original_name: 'new.GIF', content_type: 'image/png\r\nX-Fake: yes' })).toBe('image/gif')
})

it('refuses legacy redaction of an original GIF even when replacement retained a JPEG logical name', async () => {
  Object.assign(rows[1]!, { name: 'Kept.jpg.good', file_name: 'Kept.jpg.good', name_key: 'kept.jpg.good', is_private: 1, mime_type: 'image/gif' })
  const source = { id: 2, version: node_version(rows, rows[1]!) }
  await expect(begin_upload_batch(7, upload_batch_schema.parse({ scope_id: 1, request_id: crypto.randomUUID(),
    entries: [{ path: 'Kept.jpg', original_name: 'edited.png', content_type: 'image/png', purpose: 'redact', source, size: 10, sha256: 'c'.repeat(64) }] })))
    .rejects.toMatchObject({ statusCode: 409, public_data: { code: 'BATCH_REJECTED', details: { items: [expect.objectContaining({ code: 'INVALID_REDACTION' })] } } })
  expect(boundary.execute.mock.calls.some(([sql]) => sql.startsWith('INSERT INTO content_transfer_sessions'))).toBe(false)
})

it.each([
  ['Existing.GIF', 'image/gif'],
  ['Selected.GIF', 'image/gif'],
  ['Existing.SVG', 'image/svg+xml'],
])('replaces a processed image at %s using the selected file MIME %s without reencoding', async (path, mime) => {
  Object.assign(rows[1]!, { name: 'Existing.JPG', name_key: 'existing.jpg', file_name: 'Existing.JPG', mime_type: 'image/avif',
    object_key: 'old-avif', avif_key: 'old-avif', jpeg_key: 'old-jpeg', original_key: 'old-original', image_revision: 1, image_metadata: { width: 10, height: 10 } })
  const source = { id: 2, version: node_version(rows, rows[1]!) }
  const original = mime === 'image/gif' ? 'Selected.GIF' : 'Selected.SVG'
  const result = await begin_upload_batch(7, upload_batch_schema.parse({ scope_id: 1, request_id: crypto.randomUUID(),
    entries: [{ path, original_name: original, content_type: mime, purpose: 'replace', source, size: 10, sha256: 'c'.repeat(64) }] }))
  expect(session.intent.image).toBeUndefined()
  session.status = 'verifying'
  session.result = { key: 'raw-selected-file', etag: 'raw-etag', oss_version_id: 'raw-version', size: 10, sha256: 'c'.repeat(64) }
  const published = await adopt_upload_session(result.accepted[0]!.session_id, 7)
  expect(published.attachment_id).toBe(2)
  expect(published.attachment).toMatchObject({ file_name: path.replace(/\.[^.]+$/, extension => extension.toLowerCase()), mime_type: mime, is_image: true })
  expect(published.attachment?.image).toBeUndefined()
  expect(rows[1]).toMatchObject({ object_key: 'raw-selected-file', avif_key: null, jpeg_key: null, original_key: null, image_metadata: null })
  const retired = boundary.execute.mock.calls.filter(([sql]) => sql.startsWith('INSERT IGNORE INTO content_object_retirements')).map(([, args]) => args[0])
  expect(retired).toEqual(expect.arrayContaining(['old-avif', 'old-jpeg', 'old-original']))
})

it.each([false, true])('publishes exactly the affected projections and replays the durable receipt (cover=%s)', async (cover) => {
  if (cover) {
    story.cover = 'existing.txt'
    story.cover_version = 'v1'
    session.intent = { ... session.intent, purpose: 'replace', target_path: 'existing.txt', target_name: 'existing.txt', source: { id: 2, version: node_version(rows, rows[1]!) } }
  }
  const result = await adopt_upload_session(session_id, 7)
  const expected = ['content_attachments:1', `content_upload_session:${session_id}`, 'content_uploads:1', ... (cover ? ['content_stories:all', 'content_story:1'] : [])].sort()
  expect(resources()).toEqual(expected)
  expect(result.attachment_id).toBe(cover ? 2 : 3)
  expect(result).not.toHaveProperty('refresh')
  expect(session.result).toMatchObject({ refresh: { attachments: true, ... (cover ? { story: true, stories: true } : {}) } })
  const adoption_write = boundary.execute.mock.calls.findIndex(([sql]) => sql.startsWith('UPDATE content_transfer_sessions SET status'))
  const adoption_commit = boundary.commit.mock.invocationCallOrder.find(order => order > boundary.execute.mock.invocationCallOrder[adoption_write]!)
  expect(adoption_commit).toBeLessThan(boundary.publish.mock.invocationCallOrder[0]!)
  const writes = boundary.execute.mock.calls.filter(([sql]) => sql.startsWith('INSERT INTO content_story_attachments') || sql.startsWith('UPDATE content_story_attachments')).length
  boundary.publish.mockClear()
  await adopt_upload_session(session_id, 7)
  expect(resources()).toEqual(expected)
  expect(boundary.execute.mock.calls.filter(([sql]) => sql.startsWith('INSERT INTO content_story_attachments') || sql.startsWith('UPDATE content_story_attachments'))).toHaveLength(writes)
  expect(boundary.storage.mock.results.every(result => result.value === undefined)).toBe(true)
})

it('replays publication with the current namespace after a later deletion', async () => {
  const first = await adopt_upload_session(session_id, 7)
  rows = rows.filter(row => Number(row.id) !== first.attachment_id)
  story.namespace_revision ++
  const replay = await adopt_upload_session(session_id, 7)
  expect(replay.attachment_id).toBe(first.attachment_id)
  expect(replay.attachment).toBeNull()
  expect(replay.workspace.namespace_revision).toBe(story.namespace_revision)
  expect(replay.workspace.nodes?.some(node => node.id === first.attachment_id)).toBe(false)
})

it('returns authorized reservation summaries through the real list API without foreign upload sessions', async () => {
  const original = boundary.execute.getMockImplementation()!
  boundary.execute.mockImplementation(async (sql: string, args: unknown[] = []) => {
    if (sql.startsWith('SELECT id FROM content_transfer_sessions'))
      return [[]]
    if (sql.startsWith('SELECT id, target_parent_id')) {
      return [[{ id: 'foreign', target_parent_id: 1, target_path: 'remote.txt', source_attachment_id: 2, replacement_attachment_id: null,
        actor_id: 99, active_attempt_id: 'secret-attempt', expected_size: 100 }]]
    }
    return original(sql, args)
  })
  expect(await list_upload_sessions(1, 7)).toEqual({ enabled: true, sessions: [], reservations: [{ id: 'foreign', path: 'remote.txt', parent_id: 1, source_id: 2, replacement_id: undefined }] })
})

it('handles completed legacy receipts without leaking metadata or running publication again', async () => {
  session.status = 'completed'
  session.result = { attachment_id: 2, object_key: 'old-key', version: 'v1' }
  await adopt_upload_session(session_id, 7)
  expect(resources()).toEqual(['content_attachments:1', 'content_stories:all', 'content_story:1', `content_upload_session:${session_id}`, 'content_uploads:1'])
  expect(boundary.execute.mock.calls.some(([sql]) => sql.startsWith('UPDATE content_story_attachments'))).toBe(false)
})

it('rejects a retired upload object through the real publication entry without writing or notifying', async () => {
  const execute = boundary.execute.getMockImplementation()!
  boundary.execute.mockImplementation((sql: string, args: unknown[] = []) => sql.includes('FROM content_object_retirements')
    ? Promise.resolve([[{ object_key: 'new-key' }]])
    : execute(sql, args))
  await expect(adopt_upload_session(session_id, 7)).rejects.toMatchObject({ statusCode: 409 })
  expect(boundary.rollback).toHaveBeenCalled()
  expect(boundary.publish).not.toHaveBeenCalled()
  expect(boundary.execute.mock.calls.some(([sql]) => sql.startsWith('INSERT INTO content_story_attachments') || sql.startsWith('UPDATE content_story_attachments'))).toBe(false)
})

it('does not emit publication events if its transaction fails', async () => {
  // The first commit is the pre-publication state read; the second is adoption.
  boundary.commit.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('commit failed'))
  await expect(adopt_upload_session(session_id, 7)).rejects.toThrow('commit failed')
  expect(boundary.publish).not.toHaveBeenCalled()
})

it.each(['new.txt', 'folder/new.txt'])('only refreshes created directories and upload state at admission: %s', async (path) => {
  const batch = upload_batch_schema.parse({ request_id: crypto.randomUUID(), scope_id: 1, entries: [{ path, size: 10, sha256: 'c'.repeat(64) }] })
  const result = await begin_upload_batch(7, batch)
  const expected = path.includes('/') ? ['content_attachments:1', 'content_uploads:1'] : ['content_uploads:1']
  expect(resources()).toEqual(expected)
  expect(result).not.toHaveProperty('refresh')
  expect(result.accepted).toHaveLength(1)
  const insert_count = boundary.execute.mock.calls.filter(([sql]) => sql.startsWith('INSERT INTO content_transfer_sessions')).length
  boundary.publish.mockClear()
  await begin_upload_batch(7, batch)
  expect(resources()).toEqual(expected)
  expect(boundary.execute.mock.calls.filter(([sql]) => sql.startsWith('INSERT INTO content_transfer_sessions'))).toHaveLength(insert_count)
})

it('does not notify an all-skipped admission or a rejected admission', async () => {
  const batch = upload_batch_schema.parse({ request_id: crypto.randomUUID(), scope_id: 1, entries: [{ path: 'existing.txt', size: 10, sha256: 'c'.repeat(64) }] })
  await expect(begin_upload_batch(7, batch)).rejects.toMatchObject({ public_data: { code: 'BATCH_REJECTED' } })
  expect(boundary.publish).not.toHaveBeenCalled()
  const skipped = await begin_upload_batch(7, { ... batch, request_id: crypto.randomUUID(), on_error: { ... batch.on_error, name_conflict: 'skip' } })
  expect(skipped.accepted).toEqual([])
  expect(resources()).toEqual([])
})

it.each([
  ['Album.JPG/Photo.JPG', 'Album.JPG/Photo.jpg', 'public'],
  ['Album.JPG/Photo.PNG', 'Album.JPG/Photo.png.good', 'private'],
  ['Album.JPG/README', 'Album.JPG/README', 'public'],
] as const)('normalizes the direct API upload path %s before reserving it', async (path, expected, access) => {
  const batch = upload_batch_schema.parse({ request_id: crypto.randomUUID(), scope_id: 1,
    entries: [{ path, selection_root: 'Album.JPG', size: 10, sha256: 'c'.repeat(64), access }] })
  const result = await begin_upload_batch(7, batch)
  expect(result.accepted[0]?.path).toBe(expected)
  expect(session.intent).toMatchObject({ target_path: expected, target_name: expected.slice(expected.lastIndexOf('/') + 1) })
  expect(rows.some(row => row.is_folder && row.file_name === 'Album.JPG')).toBe(true)
})

it.each([['Existing.TXT', 'Existing.txt'], ['SelectedName.PDF', 'SelectedName.pdf']])('normalizes replacement %s at admission and publishes it with reference following', async (path, expected) => {
  Object.assign(rows[1]!, { name: 'Existing.TXT', file_name: 'Existing.TXT', name_key: 'existing.txt' })
  story.markdown = '[file](att://Existing.TXT)'
  const batch = upload_batch_schema.parse({ request_id: crypto.randomUUID(), scope_id: 1,
    entries: [{ path, size: 10, sha256: 'c'.repeat(64), purpose: 'replace', source: { id: 2, version: node_version(rows, rows[1]!) } }] })
  const result = await begin_upload_batch(7, batch)
  expect(result.accepted[0]?.path).toBe(expected)
  session.status = 'verifying'
  session.result = { key: 'new-key', etag: 'v2', oss_version_id: 'oss-v2', size: 10, sha256: 'c'.repeat(64) }
  const receipt = await adopt_upload_session(session.id, 7)
  expect(receipt.attachment_id).toBe(2)
  expect(rows[1]?.file_name).toBe(expected)
  expect(story.markdown).toBe(`[file](att://${expected})`)
})

it.each([false, true])('adopts a recovered ready image and publishes its exact receipt (cover=%s)', async (cover) => {
  const input = { key: 'content/att/input', etag: 'v2', version_id: 'input-v2', size: 10, sha256: 'c'.repeat(64) }
  session.intent = { ... session.intent, target_name: 'new.png', target_path: 'new.png', image: { mode: 'upload', source: null, original_name: 'photo.png', original_mime: 'image/png' } }
  session.result = { ... input, oss_version_id: input.version_id }
  if (cover)
    story.cover = 'new.png'
  const job = { id: 'd'.repeat(32), status: 'ready', attachment_id: 0, active_attempt_id: 'e'.repeat(32),
    intent: { scope_id: 1, actor_id: 7, ... session.intent.image, is_private: false, input, profile_version: 1,
      profile: { maxInputBytes: 1000, maxPixels: 1000, avifQuality: 60, avifEffort: 0, jpegQuality: 85, jpegBackground: '#ffffff', lqipMaxDimension: 24, lqipQuality: 40, timeoutSeconds: 10 } },
    result: { avif: { ... input, key: 'content/att/image.avif', etag: 'avif-v1' }, jpeg: { ... input, key: 'content/att/image.jpg' },
      original: { ... input, key: `content/att/originals/${'d'.repeat(32)}/${'e'.repeat(32)}` }, width: 10, height: 10, lqip: '/9j/2Q==' },
  }
  const execute = boundary.execute.getMockImplementation()!
  boundary.execute.mockImplementation(async (sql: string, args: unknown[] = []) => {
    if (sql.includes('ORDER BY expires_at') || sql.includes('FROM content_image_attempts') || sql.includes('FROM content_transfer_attempts a'))
      return [[]]
    if (sql.includes('SELECT s.id, s.actor_id'))
      return [[{ id: session_id, actor_id: 7, scope_id: 1, job_id: job.id, image_status: 'ready', image_epoch: 1 }]]
    if (sql.includes('FROM content_image_jobs') || sql.includes('FROM content_upload_images'))
      return [[structuredClone(job)]]
    if (sql.includes('FROM content_story_attachments WHERE id = ?'))
      return [structuredClone(rows.filter(row => row.id === args[0]))]
    if (sql.startsWith('UPDATE content_story_attachments SET original_key')) {
      Object.assign(rows.find(row => row.id === args[11])!, { original_key: args[0], avif_key: args[1], jpeg_key: args[2], image_revision: 1,
        image_metadata: args[5], lqip_jpeg: args[6], object_key: args[7], version: args[8], oss_version_id: args[9], file_size: args[10], node_revision: 2 })
    }
    if (sql.startsWith('UPDATE content_image_jobs SET status'))
      Object.assign(job, { status: 'completed', attachment_id: args[0] })
    return execute(sql, args)
  })
  await sweep_content_images()
  const expected = ['content_attachments:1', `content_upload_session:${session_id}`, 'content_uploads:1', ... (cover ? ['content_stories:all', 'content_story:1'] : [])].sort()
  expect(resources()).toEqual(expected)
  expect(session.status).toBe('completed')
  expect(job.status).toBe('completed')
  expect(rows[2]).toMatchObject({ object_key: job.result.avif.key, version: job.result.avif.etag, image_revision: 1 })
  expect(session.result).toMatchObject({ object_key: job.result.avif.key, refresh: { attachments: true, ... (cover ? { story: true, stories: true } : {}) } })
  boundary.publish.mockClear()
  await sweep_content_images()
  expect(resources()).toEqual(expected)
})
