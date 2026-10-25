import type { UploadedPart } from '@server/lib/storage'
import type { Connection, RowDataPacket } from 'mysql2/promise'
import { createHash } from 'node:crypto'
import { ApiError } from '@server/errors/ApiError'
import { db } from '@server/lib/db'
import { complete_multipart_upload, create_multipart_upload, delete_object, get_object_range, head_object, list_parts, object_sha256, put_object, storage_bucket_name, upload_part } from '@server/lib/storage'
import { publish_refresh, sync_resource } from '@server/lib/sync'
import { settings } from '@shared/settings'
import { begin_namespace_change, finish_namespace_change } from './reference-history.service'

interface SourceRow extends RowDataPacket {
  id: number
  story_id: number
  file_name: string
  object_key: string
  version: string
  file_size: number
  mime_type: string | null
  storage_bucket: 'public' | 'private'
  is_private: number
  encryption_key: string | null
}

interface MigrationRow extends RowDataPacket {
  attachment_id: number
  story_id: number
  source_key: string
  source_version: string
  source_etag: string
  source_size: number
  target_key: string
  target_version: string | null
  upload_id: string | null
  part_size: number
  parts: string | UploadedPart[]
  sha256: string | null
  state: 'copying' | 'verified' | 'adopted' | 'rolled_back' | 'retired'
}

interface MigrationOptions {
  apply: boolean
  rollback?: boolean
  retire_sources?: boolean
  attachment_id?: number
  /** Per storage request budget; CLI can override for slow networks. */
  timeout_ms?: number
  signal?: AbortSignal
}

const lock_name = 'content:secret-storage-migration'
const not_found = (error: unknown) => (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404

/** No source deletes. A durable record protects both sides, including partial uploads. */
export async function migrate_content_storage(options: MigrationOptions) {
  if (options.rollback && options.retire_sources)
    throw new ApiError(400, '源对象退役与回滚不能同时执行')
  const report: { id: number, status: 'candidate' | 'migrated' | 'rolled_back' | 'retired' | 'skipped' | 'failed', reason?: string, failure?: { type: string, status?: number } }[] = []
  const [sources] = options.rollback || options.retire_sources
    ? await db.execute<MigrationRow[]>('SELECT * FROM content_attachment_storage_migrations WHERE state = \'adopted\' ORDER BY attachment_id')
    : await db.execute<SourceRow[]>('SELECT * FROM content_story_attachments WHERE is_folder = 0 AND storage_bucket = \'public\' AND encryption_key IS NULL ORDER BY id')
  const rows = sources.filter(row => options.attachment_id === undefined || Number('attachment_id' in row ? row.attachment_id : row.id) === options.attachment_id)
  if (! options.apply)
    return rows.map(row => ({ id: Number('attachment_id' in row ? row.attachment_id : row.id), status: 'candidate' as const }))
  storage_bucket_name('private')
  const timeout_ms = options.timeout_ms ?? 120_000
  if (! Number.isSafeInteger(timeout_ms) || timeout_ms <= 0)
    throw new ApiError(400, '迁移请求超时必须为正整数')
  const signal = () => options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(timeout_ms)]) : AbortSignal.timeout(timeout_ms)
  const connection = await db.getConnection()
  let locked = false
  try {
    const [locks] = await connection.execute<RowDataPacket[]>('SELECT GET_LOCK(?, 0) AS acquired', [lock_name])
    if (Number(locks[0]?.acquired) !== 1)
      throw new ApiError(409, '已有存储迁移在执行，请等待其结束后重试')
    locked = true
    const assert_owner = async () => {
      options.signal?.throwIfAborted()
      const [owners] = await connection.execute<RowDataPacket[]>('SELECT IS_USED_LOCK(?) = CONNECTION_ID() AS owned', [lock_name])
      if (Number(owners[0]?.owned) !== 1)
        throw new ApiError(409, '迁移执行锁已失效，未发布对象')
    }
    for (const row of rows) {
      const id = Number('attachment_id' in row ? row.attachment_id : row.id)
      try {
        await assert_owner()
        if (options.retire_sources)
          await retire(row as MigrationRow, connection, assert_owner, signal)
        else if (options.rollback)
          await rollback(row as MigrationRow, connection, assert_owner, signal)
        else
          await migrate(row as SourceRow, connection, assert_owner, signal)
        report.push({ id, status: options.retire_sources ? 'retired' : options.rollback ? 'rolled_back' : 'migrated' })
        refresh(Number(row.story_id))
      }
      catch (error) {
        const details = error as { name?: string, $metadata?: { httpStatusCode?: number } }
        const type = /^[\w:.-]{1,80}$/.test(details.name ?? '') ? details.name! : 'StorageOrDatabaseError'
        report.push({ id, status: 'failed', reason: error instanceof ApiError ? error.message : '迁移未完成，检查存储／数据库后使用相同命令恢复；源对象和检查点保留', failure: { type, status: details.$metadata?.httpStatusCode } })
        if (options.signal?.aborted)
          break
      }
    }
  }
  finally {
    if (locked)
      await connection.execute('SELECT RELEASE_LOCK(?)', [lock_name]).catch(() => {})
    connection.release()
  }
  return report
}

async function migrate(source: SourceRow, connection: Connection, assert_owner: () => Promise<void>, signal: () => AbortSignal) {
  if (! source.story_id || ! source.object_key || source.is_private || source.file_name.endsWith('.good'))
    throw new ApiError(409, '旧对象行状态异常，请核对档案、位置和机密标记；密文请使用专用迁移命令')
  const head = await head_object('public', source.object_key, signal())
  if (! head.etag || head.size !== Number(source.file_size))
    throw new ApiError(409, '源对象大小或版本无法核对')
  const [existing] = await connection.execute<MigrationRow[]>('SELECT * FROM content_attachment_storage_migrations WHERE attachment_id = ?', [source.id])
  let record = existing[0]
  if (! record) {
    record = {
      attachment_id: Number(source.id), story_id: Number(source.story_id), source_key: source.object_key,
      source_version: source.version, source_etag: head.etag, source_size: head.size,
      target_key: `content/att/${crypto.randomUUID()}`, target_version: null, upload_id: null,
      part_size: Math.max(settings.app.content.upload.partSizeMb * 1024 ** 2, Math.ceil(head.size / 10_000)),
      parts: [], sha256: null, state: 'copying',
    } as MigrationRow
    await assert_owner()
    await connection.execute('INSERT INTO content_attachment_storage_migrations (attachment_id, story_id, source_key, source_version, source_etag, source_size, target_key, part_size, parts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, CAST(? AS JSON))', [record.attachment_id, record.story_id, record.source_key, record.source_version, record.source_etag, record.source_size, record.target_key, record.part_size, '[]'])
  }
  if (record.story_id !== Number(source.story_id) || record.source_key !== source.object_key || record.source_version !== source.version || record.source_etag !== head.etag || Number(record.source_size) !== head.size)
    throw new ApiError(409, '源附件已变化，拒绝复用旧迁移记录')
  const save = async () => {
    await assert_owner()
    await connection.execute('UPDATE content_attachment_storage_migrations SET upload_id = ?, parts = CAST(? AS JSON), target_version = ?, sha256 = ?, state = ? WHERE attachment_id = ?', [record.upload_id, JSON.stringify(record.parts), record.target_version, record.sha256, record.state, source.id])
  }
  let target = await optional_head(record.target_key, signal())
  const known = new Map((typeof record.parts === 'string' ? JSON.parse(record.parts) as UploadedPart[] : record.parts).map(part => [part.part_number, part]))
  record.parts = [... known.values()]
  let landed: UploadedPart[] = []
  if (! target && head.size > 0) {
    if (record.upload_id) {
      try {
        landed = await list_parts('private', record.target_key, record.upload_id, signal())
      }
      catch (error) {
        if (! not_found(error))
          throw error
        // Complete may have committed between HEAD and ListParts.
        target = await optional_head(record.target_key, signal())
        if (! target)
          record.upload_id = null
      }
    }
    if (! target && ! record.upload_id) {
      record.upload_id = await create_multipart_upload('private', record.target_key, source.mime_type, signal())
      record.parts = []
      await save()
    }
  }
  const digest = createHash('sha256')
  const parts: UploadedPart[] = []
  for (let offset = 0; offset < head.size; offset += Number(record.part_size)) {
    await assert_owner()
    const end = Math.min(head.size, offset + Number(record.part_size)) - 1
    const bytes = await get_object_range('public', source.object_key, offset, end, head.etag, signal())
    digest.update(bytes)
    if (! target) {
      const number = parts.length + 1
      const previous = known.get(number)
      const stored = landed.find(part => part.part_number === number)
      const part = previous && stored && stored.etag === previous.etag && stored.size === bytes.length
        ? stored
        : await upload_part('private', record.target_key, record.upload_id!, number, bytes, signal())
      parts.push(part)
      record.parts = [... parts]
      await save()
    }
  }
  const sha256 = digest.digest('hex')
  if (! target) {
    try {
      if (head.size === 0)
        await put_object('private', record.target_key, new Uint8Array(), source.mime_type, signal())
      else
        await complete_multipart_upload('private', record.target_key, record.upload_id!, parts, signal())
    }
    catch (error) {
      // Neither a timeout nor NoSuchUpload proves completion. Inspect the object.
      target = await optional_head(record.target_key, signal())
      if (! target)
        throw error
    }
    target ??= await optional_head(record.target_key, signal())
  }
  if (! target?.etag || target.size !== head.size)
    throw new ApiError(409, 'secret 副本大小或版本核验失败')
  const verified = await object_sha256('private', record.target_key, target.etag, signal())
  if (verified.size !== head.size || verified.sha256 !== sha256)
    throw new ApiError(409, 'secret 副本 SHA-256 核验失败，未发布')
  record.sha256 = sha256
  record.target_version = target.etag
  record.state = 'verified'
  await save()
  await assert_owner()
  try {
    await connection.beginTransaction()
    const before = await begin_namespace_change(connection, Number(source.story_id))
    const [current_rows] = await connection.execute<SourceRow[]>('SELECT * FROM content_story_attachments WHERE id = ? FOR UPDATE', [source.id])
    const current = current_rows[0]
    if (! current || current.story_id !== source.story_id || current.object_key !== source.object_key || current.version !== source.version || current.storage_bucket !== 'public' || current.encryption_key !== null || current.is_private)
      throw new ApiError(409, '附件已变化，迁移未发布；副本及检查点保留')
    await connection.execute('UPDATE content_story_attachments SET object_key = ?, version = ?, storage_bucket = \'private\' WHERE id = ?', [record.target_key, target.etag, source.id])
    await connection.execute('UPDATE content_attachment_storage_migrations SET state = \'adopted\' WHERE attachment_id = ?', [source.id])
    await finish_namespace_change(connection, before)
    await connection.commit()
  }
  catch (error) {
    await connection.rollback()
    throw error
  }
}

async function rollback(record: MigrationRow, connection: Connection, assert_owner: () => Promise<void>, signal: () => AbortSignal) {
  const original = await head_object('public', record.source_key, signal())
  if (original.size !== Number(record.source_size) || original.etag !== record.source_etag)
    throw new ApiError(409, '原公开对象大小或版本已变化，不能回滚')
  const verified = await object_sha256('public', record.source_key, record.source_etag, signal())
  if (verified.size !== Number(record.source_size) || verified.sha256 !== record.sha256)
    throw new ApiError(409, '原公开对象 SHA-256 核验失败，不能回滚')
  await assert_owner()
  try {
    await connection.beginTransaction()
    const before = await begin_namespace_change(connection, Number(record.story_id))
    const [rows] = await connection.execute<SourceRow[]>('SELECT * FROM content_story_attachments WHERE id = ? FOR UPDATE', [record.attachment_id])
    const current = rows[0]
    if (! current || current.story_id !== Number(record.story_id) || current.storage_bucket !== 'private' || current.object_key !== record.target_key || current.version !== record.target_version || current.is_private || current.encryption_key !== null)
      throw new ApiError(409, '迁移后附件已变化，不能自动回滚')
    await connection.execute('UPDATE content_story_attachments SET object_key = ?, version = ?, storage_bucket = \'public\' WHERE id = ?', [record.source_key, record.source_version, record.attachment_id])
    await connection.execute('UPDATE content_attachment_storage_migrations SET state = \'rolled_back\' WHERE attachment_id = ?', [record.attachment_id])
    await finish_namespace_change(connection, before)
    await connection.commit()
  }
  catch (error) {
    await connection.rollback()
    throw error
  }
}

/** Explicitly ends rollback protection; never called by ordinary apply. */
async function retire(record: MigrationRow, connection: Connection, assert_owner: () => Promise<void>, signal: () => AbortSignal) {
  const target = await head_object('private', record.target_key, signal())
  if (target.etag !== record.target_version || target.size !== Number(record.source_size))
    throw new ApiError(409, 'secret 副本版本或大小已变化，拒绝退役源对象')
  const verified = await object_sha256('private', record.target_key, record.target_version!, signal())
  if (verified.sha256 !== record.sha256 || verified.size !== Number(record.source_size))
    throw new ApiError(409, 'secret 副本摘要不符，拒绝退役源对象')
  await assert_owner()
  // Verify adoption before irreversible source removal. The target remains
  // protected by this record even if a concurrent replacement removes its row.
  const [rows] = await connection.execute<SourceRow[]>('SELECT * FROM content_story_attachments WHERE id = ?', [record.attachment_id])
  const current = rows[0]
  if (! current || current.storage_bucket !== 'private' || current.object_key !== record.target_key || current.version !== record.target_version || current.is_private || current.encryption_key !== null)
    throw new ApiError(409, '迁移后附件已变化，拒绝自动退役源对象')
  const [references] = await connection.execute<RowDataPacket[]>('SELECT id FROM content_story_attachments WHERE storage_bucket = \'public\' AND object_key = ? UNION SELECT attachment_id FROM content_attachment_storage_migrations WHERE source_key = ? AND attachment_id <> ? AND state <> \'retired\' UNION SELECT attachment_id FROM content_attachment_encryption_backup WHERE old_object_key = ? LIMIT 1', [record.source_key, record.source_key, record.attachment_id, record.source_key])
  if (references.length)
    throw new ApiError(409, '公开源对象仍被其他附件或回滚记录引用，请先核对共享引用')
  try {
    const source = await head_object('public', record.source_key, signal())
    if (source.etag !== record.source_etag || source.size !== Number(record.source_size))
      throw new ApiError(409, '原公开对象已变化，拒绝删除')
    await delete_object('public', record.source_key, signal())
  }
  catch (error) {
    if (! not_found(error))
      throw error
  }
  // A lost DELETE response is retried: an already missing source is acceptable,
  // but errors such as 403 never prove deletion.
  try {
    await head_object('public', record.source_key, signal())
    throw new ApiError(409, '公开源对象仍存在，退役未完成')
  }
  catch (error) {
    if (! not_found(error))
      throw error
  }
  await assert_owner()
  await connection.execute('UPDATE content_attachment_storage_migrations SET state = \'retired\' WHERE attachment_id = ? AND state = \'adopted\'', [record.attachment_id])
}

async function optional_head(key: string, signal: AbortSignal) {
  try {
    return await head_object('private', key, signal)
  }
  catch (error) {
    if (! not_found(error))
      throw error
    return null
  }
}

function refresh(story_id: number) {
  publish_refresh({ resource: sync_resource('content_attachments', story_id) })
  publish_refresh({ resource: sync_resource('content_story', story_id) })
  publish_refresh({ resource: sync_resource('content_stories', 'all') })
}
