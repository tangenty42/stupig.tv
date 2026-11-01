import type { MigrationContext } from '../migration/contract'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import { load_database_config } from '@config/loader'
import { create_audit_catalog } from '@server/services/storage-audit/repository'
import mysql from 'mysql2/promise'
import sharp from 'sharp'
import { initialize_cli_environment } from '../../config/lib/environment.mjs'
import retirement from '../../migrations/20261101143000_retire_legacy_content'
import { migrate_webp, verify_webp, webp_plan } from '../../migrations/lib/webp-v1/convert'
import { run_migrations } from '../migration/local'

initialize_cli_environment()
assert.equal(process.env.NODE_ENV, 'development')
const config = load_database_config()
const password = process.env.MYSQL_DEV_ROOT_PASSWORD
assert(password, 'Development MySQL root is required')
const name = `stupig_webp_qa_${randomUUID().replaceAll('-', '')}`
assert.match(name, /^stupig_webp_qa_[a-f\d]{32}$/)
const root = await mysql.createConnection({ host: config.host, port: config.port, user: 'root', password, timezone: 'Z' })
const objects = new Map<string, { bytes: Buffer, etag: string, version_id: string }>()
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
let writes = 0
const storage = {
  head_object: async (key: string) => {
    const object = objects.get(key)
    if (! object)
      throw Object.assign(new Error('absent'), { status: 404 })
    return { etag: object.etag, version_id: object.version_id, size: object.bytes.length }
  },
  get_object_access: async () => 'private',
  get_object_stream: async (key: string, etag: string) => {
    const object = objects.get(key)!
    assert.equal(object.etag, etag)
    return { stream: Readable.from([object.bytes]), size: object.bytes.length }
  },
  put_object: async (key: string, input: Uint8Array) => {
    writes ++
    const bytes = Buffer.from(input)
    const object = { bytes, etag: digest(bytes), version_id: `version-${writes}` }
    objects.set(key, object)
    return { etag: object.etag, version_id: object.version_id }
  },
}
let db: mysql.Connection | undefined
let created = false
try {
  await root.query(`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`)
  created = true
  await run_migrations({ database_config: { ... config, name, user: 'root', password }, maintenance: true, through: '20261030120000_shared_content_drafts.sql' })
  db = await mysql.createConnection({ host: config.host, port: config.port, user: 'root', password, database: name, timezone: 'Z' })
  const markdown = '---\ntitle: WebP QA\ncover: ![](att://photo.avif.good)\n---\n![](att://photo.avif.good)'
  await db.execute('INSERT INTO content_stories(id,title,markdown,event_precision,event_dates,cover) VALUES (1,\'WebP QA\',?,\'day\',JSON_ARRAY(),\'photo.avif.good\')', [markdown])
  const original = await sharp({ create: { width: 16, height: 12, channels: 4, background: '#ff000080' } }).png().toBuffer()
  const normal = await sharp(original).avif({ effort: 0 }).toBuffer()
  const redacted = await sharp({ create: { width: 16, height: 12, channels: 3, background: '#000000' } }).avif({ effort: 0 }).toBuffer()
  const identity = async (key: string, bytes: Buffer) => ({ key, ... await storage.put_object(key, bytes), size: bytes.length, sha256: digest(bytes) })
  const archive = await identity('content/att/qa-webp/original', original)
  const main = await identity('content/att/qa-webp/main.avif', normal)
  const hidden = await identity('content/att/qa-webp/redacted.avif', redacted)
  const raw = JSON.stringify({ original: { ... archive, name: 'photo.png' }, avif: main, jpeg: { key: 'content/att/qa-webp/old.jpg' }, width: 16, height: 12 })
  await db.execute(`INSERT INTO content_story_attachments (id,story_id,is_folder,file_name,name,name_key,parent_id,version,storage_provider,storage_bucket,is_private)
    VALUES (1,1,1,'','','',0,'root','aliyun','private',0)`)
  await db.execute(`INSERT INTO content_story_attachments (id,story_id,is_folder,file_name,name,name_key,parent_id,object_key,version,oss_version_id,mime_type,file_size,storage_provider,storage_bucket,is_private,original_key,avif_key,jpeg_key,image_revision,image_metadata,redacted_avif_key,redacted_jpeg_key,redacted_revision,redacted_metadata)
    VALUES (2,1,0,'photo.avif.good','photo.avif.good','photo.avif.good',1,?,?,?,'image/avif',?,'aliyun','private',1,?,?,'content/att/qa-webp/old.jpg',1,CAST(? AS JSON),?,'content/att/qa-webp/old-redacted.jpg',1,CAST(? AS JSON))`,
  [main.key, main.etag, main.version_id, main.size, archive.key, main.key, raw, hidden.key, JSON.stringify({ avif: hidden, width: 16, height: 12 })])
  await db.execute(`INSERT INTO content_story_drafts (id,story_id,markdown,namespace_revision,title_revision) VALUES (?,1,?,0,0)`, [randomUUID().replaceAll('-', ''), markdown])
  let rollback = true
  const ctx: MigrationContext = {
    filename: '20261101133000_content_webp.ts', db, signal: new AbortController().signal,
    assert_active: async () => {}, checkpoint: { value: null, save: async () => {} },
    oss: async () => storage as unknown as Awaited<ReturnType<MigrationContext['oss']>>,
    transaction: async (work) => {
      await db!.beginTransaction()
      try {
        const result = await work(db!)
        const [tables] = await db!.query<mysql.RowDataPacket[]>('SHOW TABLES LIKE \'content_webp_migration_objects\'')
        if (rollback && tables.length) {
          const [adopted] = await db!.query<mysql.RowDataPacket[]>('SELECT adopted FROM content_webp_migration_objects WHERE adopted = 1')
          if (adopted.length) {
            rollback = false
            throw new Error('qa_rollback_adoption')
          }
        }
        await db!.commit()
        return result
      }
      catch (error) {
        await db!.rollback()
        throw error
      }
    },
  }
  const initialWrites = writes
  await db.query('UPDATE content_story_drafts SET lease_until = TIMESTAMPADD(MINUTE, 5, CURRENT_TIMESTAMP(3))')
  assert.equal((await webp_plan(ctx)).blocked, true)
  await assert.rejects(migrate_webp(ctx), /webp_pending_work/)
  await db.query('SELECT avif_key FROM content_story_attachments LIMIT 1')
  await db.query('UPDATE content_story_drafts SET lease_until = NULL')
  assert.equal((await webp_plan(ctx)).blocked, false)
  await assert.rejects(migrate_webp(ctx), /qa_rollback_adoption/)
  const [before] = await db.query<mysql.RowDataPacket[]>('SELECT * FROM content_story_attachments WHERE id = 2')
  assert.equal(before[0]!.object_key, main.key)
  assert.equal(writes - initialWrites, 4)
  const [ledgers] = await db.query<mysql.RowDataPacket[]>('SELECT result FROM content_webp_migration_objects WHERE attachment_id = 2')
  const target = ledgers[0]!.result.normal.display.key
  const written = objects.get(target)!
  objects.set(target, { ... written, bytes: Buffer.alloc(written.bytes.length) })
  await assert.rejects(migrate_webp(ctx), /内容或版本校验失败/)
  objects.set(target, written)
  await migrate_webp(ctx)
  assert.equal(writes - initialWrites, 4, 'Resume adopts verified existing outputs without encoding again')
  assert.equal(await verify_webp(ctx), true)
  const [after] = await db.query<mysql.RowDataPacket[]>('SELECT * FROM content_story_attachments WHERE id = 2')
  const row = after[0]!
  assert.equal(row.file_name, 'photo.webp.good')
  assert.equal(row.original_key, archive.key)
  assert.equal(row.mime_type, 'image/webp')
  assert.equal(row.image_metadata.display.key, row.display_key)
  assert.equal(row.image_metadata.fallback.key, row.fallback_key)
  assert.equal('avif' in row.image_metadata, false)
  assert.equal('jpeg' in row.image_metadata, false)
  const [columns] = await db.query<mysql.RowDataPacket[]>('SHOW COLUMNS FROM content_story_attachments')
  const names = columns.map(item => item.Field)
  for (const field of ['display_key', 'fallback_key', 'source_display_key', 'redacted_display_key', 'redacted_fallback_key', 'lqip', 'redacted_lqip'])
    assert(names.includes(field))
  for (const field of ['avif_key', 'jpeg_key', 'parent_avif_key', 'redacted_avif_key', 'redacted_jpeg_key', 'lqip_jpeg', 'redacted_lqip_jpeg'])
    assert(! names.includes(field))
  assert.equal(Number(row.is_private), 1)
  const [pins] = await db.query<mysql.RowDataPacket[]>('SELECT retired_at FROM content_migration_pins WHERE object_key = ?', [main.key])
  assert.equal(pins[0]!.retired_at, null, 'Retained old display is protected from orphan cleanup')
  assert.deepEqual(objects.get(archive.key)!.bytes, original)
  assert((await sharp(objects.get(row.display_key)!.bytes).metadata()).hasAlpha)
  const publicPixels = await sharp(objects.get(row.redacted_display_key)!.bytes).removeAlpha().raw().toBuffer()
  assert(Math.max(... publicPixels) < 10, 'Redacted output comes from the black redaction, never the normal picture or archive')
  const [story] = await db.query<mysql.RowDataPacket[]>('SELECT markdown,cover FROM content_stories WHERE id = 1')
  assert.match(story[0]!.markdown, /att:\/\/photo.webp.good/)
  assert.equal(story[0]!.cover, 'photo.webp.good')
  const [drafts] = await db.query<mysql.RowDataPacket[]>('SELECT markdown,namespace_revision FROM content_story_drafts')
  assert.match(drafts[0]!.markdown, /att:\/\/photo.webp.good/)
  assert.equal(Number(drafts[0]!.namespace_revision), 1)
  await migrate_webp(ctx)
  assert.equal(writes - initialWrites, 4)
  // Exercise retirement against real legacy DDL; retain the WebP recovery ledger.
  assert.equal(Object.keys((await retirement.plan(ctx)).counts!).length, 5)
  await db.execute('INSERT INTO content_tasks (scope_id, kind, status, payload) VALUES (1, \'upload\', \'failed\', JSON_OBJECT())')
  await assert.rejects(retirement.apply(ctx), /legacy_content_tables_not_empty/)
  assert.equal(Object.keys((await retirement.plan(ctx)).counts!).length, 5)
  await db.execute('DELETE FROM content_tasks')
  let ddl = 0
  ctx.assert_active = async () => {
    if (++ ddl === 2)
      throw new Error('qa_retirement_interrupted')
  }
  await assert.rejects(retirement.apply(ctx), /qa_retirement_interrupted/)
  assert.equal(Object.keys((await retirement.plan(ctx)).counts!).length, 4)
  ctx.assert_active = async () => {}
  await retirement.apply(ctx)
  assert.equal(await retirement.verify(ctx), true)
  await retirement.apply(ctx)
  const [retained] = await db.query<mysql.RowDataPacket[]>('SELECT adopted FROM content_webp_migration_objects')
  assert.equal(Number(retained[0]!.adopted), 1)
  const [preserved] = await db.query<mysql.RowDataPacket[]>('SELECT original_key FROM content_story_attachments WHERE id = 2')
  assert.equal(preserved[0]!.original_key, archive.key)
  const catalog = create_audit_catalog(db as unknown as Parameters<typeof create_audit_catalog>[0], { bucket: 'qa', endpoint: 'https://oss.example.test' }, [])
  assert.equal(await catalog.ownership('content/att/not-tracked'), null, 'Current ownership scans work after legacy tables are removed')
  assert.equal(await catalog.ownership(main.key), 'tracked', 'Migration pins still protect old source objects')
  console.log(JSON.stringify({ webp_migration: 'passed', privacy: 'redacted source isolated', recovery: 'rollback and resume passed', archive: 'unchanged', references: 'main, cover and draft rewritten', external_oss: 'in-memory boundary' }))
}
finally {
  await db?.end()
  if (created)
    await root.query(`DROP DATABASE \`${name}\``)
  await root.end()
}
