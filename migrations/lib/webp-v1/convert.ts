import type { Connection, RowDataPacket } from 'mysql2/promise'
import type { MigrationContext, MigrationDatabase, MigrationReadContext } from '../../../scripts/migration/contract'
import { createHash, randomUUID } from 'node:crypto'
import { process_image_variants } from '../../../server/lib/webp-image-processing'
import { rewrite_cloud_drafts } from '../../../server/services/content/draft.repository'
import { verify_image_original } from '../../../server/services/content/image-original-object'
import { append_reference_journal } from '../../../server/services/content/reference-journal.repository'
import { enqueue_workspace_change } from '../../../server/services/content/workspace-sync.service'
import { format_attachment_ref, parse_content_ref } from '../../../server/shared/content-reference'
import { replay_content_references, replay_reference_destination } from '../../../server/shared/content-reference-replay'

const profile = { maxInputBytes: 96 * 1024 ** 2, maxPixels: 24_000_000, webpQuality: 100, webpEffort: 4, jpegQuality: 85, jpegBackground: '#ffffff', lqipMaxDimension: 24, lqipQuality: 40, timeoutSeconds: 120 }
const uuid = () => randomUUID().replaceAll('-', '')
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
const json = (value: any) => typeof value === 'string' ? JSON.parse(value) : value
const state = (row: RowDataPacket) => JSON.stringify([Number(row.id), Number(row.story_id), row.file_name, row.display_key, row.fallback_key, row.redacted_display_key, row.redacted_fallback_key, Number(row.node_revision), Number(row.image_revision), Number(row.redacted_revision), row.original_key, row.is_private, row.storage_provider, row.encryption_key])
const needs = (row: RowDataPacket) => Boolean((row.display_key && ! String(row.display_key).endsWith('.webp')) || (row.redacted_display_key && ! String(row.redacted_display_key).endsWith('.webp')))

async function column(db: MigrationDatabase, table: string, name: string) {
  const [rows] = await db.execute<RowDataPacket[]>('SELECT COUNT(*) AS n FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?', [table, name])
  return Number(rows[0]?.n) > 0
}
async function quiet(db: MigrationDatabase) {
  const [rows] = await db.execute<RowDataPacket[]>(`SELECT
    (SELECT COUNT(*) FROM content_transfer_sessions WHERE status IN ('uploading','queued','running','verifying')) AS transfers,
    (SELECT COUNT(*) FROM content_image_jobs WHERE status IN ('queued','processing','ready','failed')) AS images,
    (SELECT COUNT(*) FROM content_story_drafts WHERE lease_until > CURRENT_TIMESTAMP(3)) AS draft_leases`)
  return { transfers: Number(rows[0]?.transfers), images: Number(rows[0]?.images), draft_leases: Number(rows[0]?.draft_leases) }
}
export async function webp_plan(ctx: MigrationReadContext) {
  const renamed = await column(ctx.db, 'content_story_attachments', 'display_key')
  const main = renamed ? 'display_key' : 'avif_key'
  const redacted = await column(ctx.db, 'content_story_attachments', 'redacted_display_key') ? 'redacted_display_key' : 'redacted_avif_key'
  const [rows] = await ctx.db.execute<RowDataPacket[]>(`SELECT COUNT(*) AS images FROM content_story_attachments WHERE ${main} IS NOT NULL OR ${redacted} IS NOT NULL`)
  const pending = await quiet(ctx.db)
  return { summary: 'Convert current normal and redacted display images to WebP Q100; retain original archives and old private objects', counts: { attachments: Number(rows[0]?.images), ... pending }, blocked: Object.values(pending).some(Boolean) }
}

/** Logical names follow the new display format; privacy markers and directories survive. */
export function webp_name(name: string, occupied: Set<string>, max_bytes = 255) {
  const marker = /\.good$/i.test(name) ? name.slice(- 5) : ''
  const clear = marker ? name.slice(0, - 5) : name
  const stem = clear.replace(/\.[^.]+$/, '')
  const key = (value: string) => value.normalize('NFC').toLowerCase()
  for (let index = 1; ; index ++) {
    const suffix = `${index === 1 ? '' : `_${index}`}.webp${marker}`
    if (Buffer.byteLength(suffix) > max_bytes)
      throw new Error('webp_path_too_long')
    let base = stem
    while (Buffer.byteLength(base + suffix) > max_bytes) base = [... base].slice(0, - 1).join('')
    const target = base + suffix
    if (! occupied.has(key(target)))
      return target
  }
}

async function bytes(ctx: MigrationContext, storage: Awaited<ReturnType<MigrationContext['oss']>>, key: string, expected?: any) {
  const before = await storage.head_object(key)
  if (! before.version_id || before.size > profile.maxInputBytes || await storage.get_object_access(key) !== 'private'
    || (expected && (expected.key !== key || expected.etag !== before.etag || expected.version_id !== before.version_id || expected.size !== before.size))) {
    throw new Error('webp_source_identity_mismatch')
  }
  const stream = await storage.get_object_stream(key, before.etag, ctx.signal)
  if (stream.size !== before.size) {
    stream.stream.destroy()
    throw new Error('webp_source_size_mismatch')
  }
  const chunks: Buffer[] = []
  let length = 0
  for await (const chunk of stream.stream) {
    length += chunk.length
    if (length > before.size) {
      stream.stream.destroy()
      throw new Error('webp_source_overflow')
    }
    chunks.push(Buffer.from(chunk))
    ctx.signal.throwIfAborted()
  }
  const body = Buffer.concat(chunks)
  const after = await storage.head_object(key)
  if (length !== before.size || after.etag !== before.etag || after.version_id !== before.version_id || (expected?.sha256 && expected.sha256 !== sha256(body)))
    throw new Error('webp_source_changed')
  return body
}

export async function migrate_webp(ctx: MigrationContext) {
  if (Object.values(await quiet(ctx.db)).some(Boolean))
    throw new Error('webp_pending_work')
  // DDL is individually resumable; it must run only behind the maintenance gate.
  for (const [table, old, next] of [
    ['content_story_attachments', 'avif_key', 'display_key'],
    ['content_story_attachments', 'parent_avif_key', 'source_display_key'],
    ['content_story_attachments', 'redacted_avif_key', 'redacted_display_key'],
    ['content_image_attempts', 'avif_key', 'display_key'],
    ['content_story_attachments', 'jpeg_key', 'fallback_key'],
    ['content_story_attachments', 'redacted_jpeg_key', 'redacted_fallback_key'],
    ['content_story_attachments', 'lqip_jpeg', 'lqip'],
    ['content_story_attachments', 'redacted_lqip_jpeg', 'redacted_lqip'],
    ['content_image_attempts', 'jpeg_key', 'fallback_key'],
  ]) {
    await ctx.assert_active()
    if (await column(ctx.db, table!, old!))
      await ctx.db.query(`ALTER TABLE ${table} RENAME COLUMN ${old} TO ${next}`)
  }
  await ctx.db.query(`CREATE TABLE IF NOT EXISTS content_webp_migration_objects (
    attachment_id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
    source_snapshot JSON NOT NULL,
    target_prefix VARCHAR(512) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    result JSON NULL,
    adopted TINYINT(1) NOT NULL DEFAULT 0
  )`)
  const [rows] = await ctx.db.execute<RowDataPacket[]>('SELECT * FROM content_story_attachments WHERE display_key IS NOT NULL OR redacted_display_key IS NOT NULL ORDER BY story_id, id')
  let storage: Awaited<ReturnType<MigrationContext['oss']>> | undefined
  for (const source of rows) {
    if (! needs(source))
      continue
    await ctx.assert_active()
    storage ??= await ctx.oss()
    await ctx.transaction(async (db) => {
      await db.execute('SELECT id FROM content_stories WHERE id = ? FOR UPDATE', [source.story_id])
      const [current] = await db.execute<RowDataPacket[]>('SELECT * FROM content_story_attachments WHERE id = ? FOR UPDATE', [source.id])
      if (! current[0] || state(current[0]) !== state(source))
        throw new Error('webp_attachment_changed')
      const snapshot = { state: state(source), normal: json(source.image_metadata), redacted: json(source.redacted_metadata), original_key: source.original_key, file_name: source.file_name }
      await db.execute('INSERT IGNORE INTO content_webp_migration_objects (attachment_id, source_snapshot, target_prefix) VALUES (?, CAST(? AS JSON), ?)', [source.id, JSON.stringify(snapshot), `content/att/images/${uuid()}/${uuid()}`])
      // Existing migration pins are already honored by the audit/cleanup boundary.
      for (const key of [source.display_key, source.fallback_key, source.redacted_display_key, source.redacted_fallback_key].filter(Boolean))
        await db.execute('INSERT INTO content_migration_pins (object_key, scope_id) VALUES (?, ?) ON DUPLICATE KEY UPDATE retired_at = NULL', [key, source.story_id])
    })
    const [ledgers] = await ctx.db.execute<RowDataPacket[]>('SELECT * FROM content_webp_migration_objects WHERE attachment_id = ?', [source.id])
    const ledger = ledgers[0]!
    if (json(ledger.source_snapshot).state !== state(source) || ledger.adopted)
      throw new Error('webp_ledger_mismatch')
    const prefix = String(ledger.target_prefix)
    if (! /^content\/att\/images\/[\da-f]{32}\/[\da-f]{32}$/.test(prefix))
      throw new Error('webp_target_scope_mismatch')
    const targetKeys = ['normal', 'redacted'].flatMap(role => ['webp', 'jpg'].map(extension => `${prefix}-${role}.${extension}`))
    await ctx.transaction(async (db) => {
      for (const key of targetKeys)
        await db.execute('INSERT IGNORE INTO content_migration_pins (object_key, scope_id) VALUES (?, ?)', [key, source.story_id])
    })
    let result = json(ledger.result)
    if (! result) {
      result = {}
      for (const [role, key, metadata] of [
        ['normal', source.display_key, json(source.image_metadata)],
        ['redacted', source.redacted_display_key, json(source.redacted_metadata)],
      ] as const) {
        if (! key || String(key).endsWith('.webp'))
          continue
        if (! metadata?.avif || source.storage_provider !== 'aliyun' || source.encryption_key !== null)
          throw new Error('webp_source_metadata_missing')
        const output = await process_image_variants(await bytes(ctx, storage, String(key), metadata.avif), profile)
        const write = async (extension: string, body: Buffer, mime: string) => {
          const target = `${prefix}-${role}.${extension}`
          const receipt = await storage!.put_object(target, body, mime, 'private')
          if (! receipt.version_id)
            throw new Error('webp_target_not_versioned')
          return { key: target, ... receipt, version_id: receipt.version_id, size: body.length, sha256: sha256(body) }
        }
        const display = await write('webp', output.display, 'image/webp')
        const fallback = await write('jpg', output.fallback, 'image/jpeg')
        result[role] = { display, fallback, width: output.width, height: output.height, lqip: output.lqip.toString('base64') }
      }
      await ctx.transaction(db => db.execute('UPDATE content_webp_migration_objects SET result = CAST(? AS JSON) WHERE attachment_id = ? AND adopted = 0', [JSON.stringify(result), source.id]).then(() => undefined))
    }
    for (const role of Object.values(result) as any[]) {
      for (const object of [role.display, role.fallback]) {
        if (! object.key.startsWith(`${prefix}-`))
          throw new Error('webp_result_scope_mismatch')
        const verified = await verify_image_original(storage, object.key, object, ctx.signal)
        if (verified.etag !== object.etag || verified.version_id !== object.version_id)
          throw new Error('webp_target_changed')
      }
    }
    // Refence replays and all representation pointers publish in one DB transaction.
    await ctx.transaction(async (db) => {
      const connection = db as Connection
      const [stories] = await db.execute<RowDataPacket[]>('SELECT * FROM content_stories WHERE id = ? FOR UPDATE', [source.story_id])
      const story = stories[0]!
      const [current] = await db.execute<RowDataPacket[]>('SELECT * FROM content_story_attachments WHERE id = ? FOR UPDATE', [source.id])
      if (! current[0] || state(current[0]) !== state(source))
        throw new Error('webp_attachment_changed')
      let path = String(source.file_name)
      if (result.normal) {
        const [siblings] = await db.execute<RowDataPacket[]>('SELECT id, name FROM content_story_attachments WHERE parent_id = ? AND id <> ? FOR UPDATE', [source.parent_id, source.id])
        const parentPath = path.slice(0, path.length - String(source.name).length)
        const name = /\.avif(?:\.good)?$/i.test(String(source.name))
          ? webp_name(String(source.name), new Set(siblings.map(row => String(row.name).normalize('NFC').toLowerCase())), 255 - Buffer.byteLength(parentPath))
          : String(source.name)
        path = path.slice(0, path.length - String(source.name).length) + name
        if (Buffer.byteLength(path) > 255)
          throw new Error('webp_path_too_long')
        const previous = json(source.image_metadata) ?? {}
        const { avif: _old, jpeg: _oldFallback, ... metadata } = previous
        await db.execute(`UPDATE content_story_attachments SET display_key = ?, fallback_key = ?, object_key = ?, version = ?, oss_version_id = ?, file_size = ?, mime_type = 'image/webp',
          image_metadata = CAST(? AS JSON), lqip = ?, image_revision = image_revision + 1, name = ?, name_key = ?, file_name = ? WHERE id = ?`,
        [result.normal.display.key, result.normal.fallback.key, result.normal.display.key, result.normal.display.etag, result.normal.display.version_id, result.normal.display.size,
          JSON.stringify({ ... metadata, display: result.normal.display, fallback: result.normal.fallback, width: result.normal.width, height: result.normal.height, profile_version: 3 }), Buffer.from(result.normal.lqip, 'base64'), name, name.normalize('NFC').toLowerCase(), path, source.id])
      }
      if (result.redacted) {
        const { avif: _old, jpeg: _oldFallback, ... metadata } = json(source.redacted_metadata) ?? {}
        await db.execute(`UPDATE content_story_attachments SET redacted_display_key = ?, redacted_fallback_key = ?, redacted_metadata = CAST(? AS JSON), redacted_lqip = ?, redacted_revision = redacted_revision + 1 WHERE id = ?`,
          [result.redacted.display.key, result.redacted.fallback.key, JSON.stringify({ ... metadata, display: result.redacted.display, fallback: result.redacted.fallback, width: result.redacted.width, height: result.redacted.height }), Buffer.from(result.redacted.lqip, 'base64'), source.id])
      }
      await db.execute('UPDATE content_story_attachments SET read_revision = read_revision + 1, node_revision = node_revision + 1 WHERE id = ?', [source.id])
      const journal = { revision: Number(story.namespace_revision) + 1, changes: path === source.file_name ? [] : [{ node_id: Number(source.id), from: format_attachment_ref(String(source.file_name)), to: format_attachment_ref(path) }] }
      await append_reference_journal(connection, Number(source.story_id), journal.revision, journal.changes)
      const markdown = replay_content_references(String(story.markdown), { attachments: [journal], titles: [], attachment_targets: [], title_targets: [] }, false).markdown
      const coverRef = parse_content_ref(replay_reference_destination(format_attachment_ref(String(story.cover ?? '')), [journal]))
      const cover = coverRef && 'path' in coverRef ? coverRef.path : String(story.cover ?? '')
      const coverVersion = cover === path && result.normal ? result.normal.display.etag : story.cover_version
      await db.execute('UPDATE content_stories SET markdown = ?, cover = ?, cover_version = ?, namespace_revision = ?, updated_at = updated_at WHERE id = ?', [markdown, cover, coverVersion, journal.revision, source.story_id])
      await rewrite_cloud_drafts(connection, Number(source.story_id), journal)
      await enqueue_workspace_change(connection, Number(source.story_id), { attachments: true, story: true, stories: true })
      await db.execute('UPDATE content_webp_migration_objects SET adopted = 1 WHERE attachment_id = ?', [source.id])
      for (const key of targetKeys)
        await db.execute('UPDATE content_migration_pins SET retired_at = CURRENT_TIMESTAMP WHERE object_key = ? AND scope_id = ?', [key, source.story_id])
    })
    await ctx.checkpoint.save({ last_attachment: Number(source.id) })
  }
}

export async function verify_webp(ctx: MigrationReadContext) {
  if (! await column(ctx.db, 'content_story_attachments', 'display_key') || ! await column(ctx.db, 'content_story_attachments', 'redacted_display_key'))
    return false
  const [rows] = await ctx.db.execute<RowDataPacket[]>('SELECT * FROM content_story_attachments WHERE display_key IS NOT NULL OR redacted_display_key IS NOT NULL')
  return rows.every(row => ! needs(row) && (! row.display_key || row.mime_type === 'image/webp'))
}
