import type { Identity } from '../../migrations/lib/content-v1/objects'
import type { MigrationContext } from '../migration/contract'
import assert from 'node:assert/strict'
import { createCipheriv, randomBytes, randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import { DeleteObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { load_aliyun_oss_config, load_database_config, load_migration_source_config } from '@config/loader'
import { create_aliyun_oss } from '@server/lib/aliyun-oss'
import OSS from 'ali-oss'
import mysql from 'mysql2/promise'
import sharp from 'sharp'
import { initialize_cli_environment } from '../../config/lib/environment.mjs'
import { digest } from '../../migrations/lib/content-v1/plan'
import { migrate_references } from '../../migrations/lib/content-v1/references'
import { migrate_workspace, verify_workspace, workspace_plan } from '../../migrations/lib/content-v1/workspace'
import { run_migrations } from '../migration/local'

let phase = 'configuration'
/** DB and codec are real; --oss additionally replaces the in-memory remote boundary with development OSS. */
async function verify() {
  initialize_cli_environment()
  assert.equal(process.env.NODE_ENV, 'development')
  const config = load_database_config()
  const password = process.env.MYSQL_DEV_ROOT_PASSWORD
  assert(password, 'Development MySQL root is required')
  const root = await mysql.createConnection({ host: config.host, port: config.port, user: 'root', password, timezone: 'Z' })
  const name = `stupig_content_qa_${randomUUID().replaceAll('-', '')}`
  assert.match(name, /^stupig_content_qa_[a-f\d]{32}$/)
  const prefix = `content/att/qa-migration/${randomUUID()}/`
  const cloud = process.argv.includes('--oss') || process.argv.includes('--legacy')
  const destination = cloud ? load_aliyun_oss_config() : null
  if (cloud)
    assert(destination && /dev/.test(destination.bucket), 'Only a development bucket may be tested')
  const raw = destination ? new OSS({ ... destination, secure: true, authorizationV4: true }) : null
  const objects = new Map<string, Buffer>()
  const uploads = new Map<string, Map<number, Buffer>>()
  const owned = new Set<string>()
  const storage = destination
    ? create_aliyun_oss(destination)
    : {
        head_object: async (key: string) => {
          const bytes = objects.get(key)
          if (! bytes)
            throw Object.assign(new Error('absent'), { status: 404 })
          return { etag: digest(bytes), size: bytes.length, version_id: 'v1' }
        },
        get_object_access: async () => 'private' as const,
        get_object_stream: async (key: string, etag: string) => {
          const bytes = objects.get(key)!
          assert.equal(digest(bytes), etag)
          return { stream: Readable.from([bytes]), size: bytes.length }
        },
        put_object: async (key: string, bytes: Uint8Array) => {
          objects.set(key, Buffer.from(bytes))
          return { etag: digest(bytes), version_id: 'v1' }
        },
        list_multipart_uploads: async () => [],
        create_multipart_upload: async () => {
          const id = randomUUID()
          uploads.set(id, new Map())
          return id
        },
        list_multipart_parts: async (_key: string, id: string) => ({ parts: [... uploads.get(id)!].map(([part_number, bytes]) => ({ part_number, etag: digest(bytes), size: bytes.length })), next_marker: null }),
        upload_part: async (_key: string, id: string, part_number: number, bytes: Uint8Array) => {
          uploads.get(id)!.set(part_number, Buffer.from(bytes))
          return { part_number, etag: digest(bytes), size: bytes.length }
        },
        complete_multipart_upload: async (key: string, id: string) => {
          const bytes = Buffer.concat([... uploads.get(id)!].sort(([a], [b]) => a - b).map(([, bytes]) => bytes))
          objects.set(key, bytes)
          uploads.delete(id)
          return { etag: digest(bytes), version_id: 'v1' }
        },
      }
  let db: mysql.Connection | null = null
  let created = false
  let rollback_adoption = true
  let checkpoint_count = 0
  let legacy: { client: S3Client, bucket: string, key: string, version: string | undefined } | null = null
  try {
    phase = 'schema'
    await root.query(`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`)
    created = true
    await run_migrations({ database_config: { ... config, name, user: 'root', password }, through: '20261024210000_content_cutover_state.sql' })
    db = await mysql.createConnection({ host: config.host, port: config.port, user: 'root', password, database: name, timezone: 'Z' })
    await db.query('SET time_zone=\'+00:00\'')
    await db.query('CREATE TABLE qa_checkpoints(n INT NOT NULL)')
    phase = 'fixtures'
    const context: MigrationContext = {
      filename: '20261024210200_content_workspace.ts', db, signal: new AbortController().signal,
      assert_active: async () => {},
      checkpoint: { value: null, save: async () => { await db!.execute('INSERT INTO qa_checkpoints VALUES (?)', [++ checkpoint_count]) } },
      oss: async () => storage as Awaited<ReturnType<MigrationContext['oss']>>,
      transaction: async (work) => {
        await db!.beginTransaction()
        try {
          const result = await work(db!)
          const [[adopted]] = await db!.query<mysql.RowDataPacket[]>('SELECT COUNT(*) n FROM content_migration_scopes WHERE state=\'adopted\'')
          if (rollback_adoption && Number(adopted!.n)) {
            rollback_adoption = false
            throw new Error('qa_rollback_adoption')
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
    const png = await sharp({ create: { width: 16, height: 12, channels: 4, background: '#ff0000' } }).png().toBuffer()
    const public_png = await sharp({ create: { width: 8, height: 6, channels: 4, background: '#0000ff' } }).png().toBuffer()
    const original_key = randomBytes(32)
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', original_key, iv)
    const encrypted = Buffer.concat([iv, cipher.update(png), cipher.final(), cipher.getAuthTag()])
    const large = Buffer.alloc(9 * 1024 * 1024, 137)
    const markdown = '---\ntitle: QA\ncover: a/图.PNG\n---\n\n![secret](a/secret.PNG.good)\n\n![public](a/secret.PNG)\n\n[](vault/原件.bin)\n\n[](a/图.PNG)'
    await db.execute('INSERT INTO content_stories(id,title,markdown,event_precision,event_dates,cover) VALUES (1,\'QA\',?,\'day\',JSON_ARRAY(),\'a/图.PNG\')', [markdown])
    const add = async (id: number, path: string, bytes: Buffer, mime: string, encryption: string | null = null) => {
      const key = `${prefix}${id}`
      owned.add(key)
      const head = await storage.put_object(key, bytes, mime)
      await db!.execute(`INSERT INTO content_story_attachments(id,story_id,file_name,object_key,mime_type,file_size,version,oss_version_id,storage_provider,storage_bucket,encryption_key,is_private)
        VALUES (?,1,?,?,?,?,?,?,'aliyun','private',?,?)`, [id, path, key, mime, bytes.length, head.etag, head.version_id, encryption, Number(!! encryption)])
    }
    await add(1, 'a/图.PNG', png, 'image/png')
    await add(2, 'a/secret.PNG.good', encrypted, 'image/png', original_key.toString('base64'))
    await add(3, 'a/secret.PNG', public_png, 'image/png')
    await add(4, 'a/动画.GIF', Buffer.from('GIF89a-unchanged'), 'image/gif')
    // Force raw Aliyun originals to be migrated as old encrypted shapes as well.
    for (const id of [4]) {
      const bytes = objects.get(`${prefix}${id}`) ?? Buffer.from('GIF89a-unchanged')
      const cipher = createCipheriv('aes-256-gcm', original_key, iv)
      const value = Buffer.concat([iv, cipher.update(bytes), cipher.final(), cipher.getAuthTag()])
      const head = await storage.put_object(`${prefix}${id}`, value, 'image/gif')
      await db.execute('UPDATE content_story_attachments SET encryption_key=?,version=?,oss_version_id=?,file_size=? WHERE id=?', [original_key.toString('base64'), head.etag, head.version_id, value.length, id])
    }
    const large_cipher = createCipheriv('aes-256-gcm', original_key, iv)
    await add(5, 'vault/原件.bin', Buffer.concat([iv, large_cipher.update(large), large_cipher.final(), large_cipher.getAuthTag()]), 'application/octet-stream', original_key.toString('base64'))
    await db.execute('INSERT INTO content_story_attachments(id,story_id,file_name,is_folder,is_private,version) VALUES (6,1,\'vault\',1,1,\'folder\')')
    if (process.argv.includes('--legacy')) {
      const source = load_migration_source_config('public')
      assert.match(source.bucket, /dev/)
      const client = new S3Client({ endpoint: source.endpoint, region: source.region, forcePathStyle: source.forcePathStyle, credentials: { accessKeyId: source.accessKeyId, secretAccessKey: source.accessKeySecret }, requestHandler: { connectionTimeout: source.connectionTimeoutMs, requestTimeout: source.requestTimeoutMs } })
      const key = `${prefix}legacy.svg`
      const bytes = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"/>')
      const result = await client.send(new PutObjectCommand({ Bucket: source.bucket, Key: key, Body: bytes, ContentType: 'image/svg+xml' }))
      legacy = { client, bucket: source.bucket, key, version: result.VersionId }
      await db.execute('INSERT INTO content_story_attachments(id,story_id,file_name,object_key,mime_type,file_size,version,storage_provider,storage_bucket) VALUES (7,1,\'legacy.SVG.good\',?,\'image/svg+xml\',?,\'legacy-cache-version\',\'legacy\',\'public\')', [key, bytes.length])
    }
    // Quiescence blocks even the reference phase and leaves no source backup.
    await db.execute('INSERT INTO content_tasks(scope_id,kind,status,payload) VALUES (1,\'upload\',\'failed\',JSON_OBJECT())')
    await assert.rejects(migrate_references(context), /pending_work/)
    const [[backups]] = await db.query<mysql.RowDataPacket[]>('SELECT COUNT(*) n FROM content_migration_references')
    assert.equal(Number(backups!.n), 0)
    await db.execute('DELETE FROM content_tasks')
    await migrate_references(context)
    phase = 'plan'
    const report = await workspace_plan(context)
    assert.equal(report.blocked, false)
    assert.equal(report.counts.redacted, 1)
    await assert.rejects(migrate_workspace(context), /qa_rollback_adoption/)
    phase = 'resume'
    const [[unpublished]] = await db.query<mysql.RowDataPacket[]>('SELECT parent_id FROM content_story_attachments WHERE id=1')
    assert.equal(unpublished!.parent_id, null)
    const [[count_before]] = await db.query<mysql.RowDataPacket[]>('SELECT COUNT(*) n FROM content_migration_objects')
    await migrate_workspace(context)
    phase = 'verification'
    assert.equal(await verify_workspace(context), true)
    const [nodes] = await db.query<mysql.RowDataPacket[]>('SELECT * FROM content_story_attachments ORDER BY id')
    const secret = nodes.find(node => node.id === 2)!
    const public_twin = nodes.find(node => node.id === 3)!
    assert(secret.redacted_avif_key && secret.redacted_jpeg_key && secret.original_key)
    assert.notEqual(secret.redacted_avif_key, public_twin.avif_key)
    assert.equal(public_twin.file_name, 'a/secret.png')
    assert.equal(secret.encryption_key, null)
    assert.equal(nodes.find(node => node.id === 5)!.file_name, 'vault.good/原件.bin')
    assert.equal(nodes.find(node => node.id === 5)!.is_private, 1)
    const [[story]] = await db.query<mysql.RowDataPacket[]>('SELECT * FROM content_stories WHERE id=1')
    assert.equal(story!.cover, 'a/图.png')
    assert.match(story!.markdown, /att:\/\/a\/secret.png.good/)
    assert.match(story!.markdown, /att:\/\/vault.good\/原件.bin/)
    assert.equal(story!.revision, 1)
    assert.equal(story!.namespace_revision, story!.namespace_floor)
    const [receipts] = await db.query<mysql.RowDataPacket[]>('SELECT result FROM content_migration_objects')
    const archive = JSON.parse(JSON.stringify(secret.image_metadata)).original as Identity
    const stream = await storage.get_object_stream(archive.key, archive.etag)
    const chunks = []
    for await (const bytes of stream.stream) chunks.push(Buffer.from(bytes))
    assert.deepEqual(Buffer.concat(chunks), png)
    await migrate_workspace(context)
    const [[count_after]] = await db.query<mysql.RowDataPacket[]>('SELECT COUNT(*) n FROM content_migration_objects')
    assert.equal(count_after!.n, count_before!.n)
    assert.equal(receipts.length, Number(count_before!.n))
    // A post-adoption mutation cannot be silently blessed by a resumed migration.
    await db.execute('UPDATE content_stories SET title=\'changed\',updated_at=updated_at WHERE id=1')
    assert.equal(await verify_workspace(context), false)
    await assert.rejects(migrate_workspace(context), /adopted_scope_changed/)
    console.log(`content_migration_verified: ${cloud ? 'real-development-OSS' : 'memory-storage-boundary'}, ${legacy ? 'real-legacy-S3,' : ''} real-MySQL, real-Sharp, AES, multipart, independent-redaction, stable-IDs, references, cover, namespace-fence, rollback, resume, quiescence, post-adoption-mutation`)
  }
  finally {
    try {
      if (db) {
        const [targets] = await db.query<mysql.RowDataPacket[]>('SELECT target_key FROM content_migration_objects')
        for (const row of targets) {
          assert.match(row.target_key, /^content\/att\/migrations\/1\/[a-f\d]{32}\//)
          owned.add(row.target_key)
        }
      }
      if (raw) {
        // Only exact keys from this isolated DB plus this invocation's random source prefix.
        // Soft deletion intentionally preserves bucket versions under the development retention policy.
        for (const key of owned) await raw.delete(key)
      }
      if (legacy) {
        assert(legacy.key.startsWith(prefix))
        await legacy.client.send(new DeleteObjectCommand({ Bucket: legacy.bucket, Key: legacy.key, VersionId: legacy.version }))
      }
    }
    finally {
      if (db)
        await db.end()
      try {
        if (created)
          await root.query(`DROP DATABASE \`${name}\``)
      }
      finally { await root.end() }
    }
  }
}

void verify().catch((error: unknown) => {
  // Never emit raw SDK errors, connection configuration, snapshots, or signed requests.
  console.error('content_migration_verification_failed', { phase, kind: error instanceof Error ? error.name : 'unknown', code: error instanceof Error && /^(?:qa_|migration_|content_migration_)/.test(error.message) ? error.message : (error as { code?: string }).code })
  process.exitCode = 1
})
