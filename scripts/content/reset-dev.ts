import type { RowDataPacket } from 'mysql2/promise'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { load_config, runtime_config } from '@config/loader'
import { create_aliyun_oss } from '@server/lib/aliyun-oss'
import { abort_multipart_upload, delete_object, list_multipart_uploads, list_objects } from '@server/lib/storage'
import { image_original_key } from '@server/services/content/image-original-object'
import OSS from 'ali-oss'
import mysql from 'mysql2/promise'

interface ResetObject { key: string, location: 'aliyun' | 'public' | 'private', upload_id?: string }
export function configured_reset_buckets(config: {
  aliyun: { oss: { bucket: string } | null }
  oss: { buckets: { public: { bucket: string }, private: { bucket: string } | null } }
}) {
  assert.ok(config.aliyun.oss, 'Aliyun OSS must be configured for Content reset')
  return [config.aliyun.oss.bucket, config.oss.buckets.public.bucket, ... (config.oss.buckets.private ? [config.oss.buckets.private.bucket] : [])]
}

export function assert_development_reset(environment: string | undefined, database: string, buckets: string[], production: string[], host: string) {
  assert.equal(environment, 'development', 'Content reset is development-only')
  assert.ok(['127.0.0.1', 'localhost', '::1'].includes(host), 'Refuse a non-local development database')
  // docker-compose.dev.yml intentionally uses the same logical DB name as production.
  assert.match(database, /dev|local|^stupig_tv$/i, 'Refuse an unrecognized development database')
  assert.ok(buckets.length > 0 && buckets.every(bucket => /dev/i.test(bucket) && ! production.includes(bucket)), 'Development and production buckets must be distinct')
}
export function assert_reset_object(object: ResetObject) {
  assert.ok(['aliyun', 'public', 'private'].includes(object.location))
  assert.match(object.key, /^(?:content\/|content-upload\/)/, 'Refuse non-Content objects')
  assert.ok(! object.key.includes('..'))
}

/** Inventory current objects only; historical versions follow bucket retention. */
export async function inventory_aliyun_content(client: Pick<OSS, 'listV2' | 'listUploads'>) {
  const objects: ResetObject[] = []
  for (const prefix of ['content/', 'content-upload/']) {
    let token: string | undefined
    do {
      const page = await client.listV2({ prefix, 'max-keys': 1000, ... (token ? { 'continuation-token': token } : {}) })
      for (const object of page.objects ?? []) {
        const value: ResetObject = { key: object.name, location: 'aliyun' }
        assert_reset_object(value)
        assert.ok(value.key.startsWith(prefix), 'Object escaped the requested Content prefix')
        objects.push(value)
      }
      const next = page.isTruncated ? page.nextContinuationToken : undefined
      assert.ok(! page.isTruncated || (next && next !== token), 'Incomplete Content object inventory')
      token = next
    } while (token)
    let key: string | undefined
    let upload: string | undefined
    do {
      const page = await client.listUploads({ prefix, 'max-uploads': 1000, ... (key ? { 'key-marker': key } : {}), ... (upload ? { 'upload-id-marker': upload } : {}) })
      for (const object of page.uploads ?? []) {
        const value: ResetObject = { key: object.name, location: 'aliyun', upload_id: object.uploadId }
        assert_reset_object(value)
        assert.ok(value.key.startsWith(prefix) && value.upload_id, 'Upload escaped the requested Content prefix')
        objects.push(value)
      }
      const next_key = page.isTruncated ? String(page.nextKeyMarker ?? '') : undefined
      const next_upload = page.isTruncated ? String(page.nextUploadIdMarker ?? '') : undefined
      assert.ok(! page.isTruncated || ((next_key || next_upload) && (next_key !== key || next_upload !== upload)), 'Incomplete Content multipart inventory')
      key = next_key
      upload = next_upload
    } while (key || upload)
  }
  return objects
}

export function reset_attachment_objects(row: { object_key?: string | null, original_key?: string | null, avif_key?: string | null, jpeg_key?: string | null, redacted_avif_key?: string | null, redacted_jpeg_key?: string | null, storage_provider?: string, storage_bucket?: string }) {
  const location: ResetObject['location'] = row.storage_provider === 'aliyun' ? 'aliyun' : row.storage_bucket as 'public' | 'private'
  return [... new Set([row.object_key, row.original_key, row.avif_key, row.jpeg_key, row.redacted_avif_key, row.redacted_jpeg_key].filter((key): key is string => !! key))].map(key => ({ key, location }))
}

export function reset_image_attempt_objects(row: { id: string, job_id: string, avif_key: string, jpeg_key: string }) {
  return reset_attachment_objects({ ... row, original_key: image_original_key(row.job_id, row.id), storage_provider: 'aliyun' })
}

/** Explicit apply; write a resumable manifest before deleting development rows. */
export async function reset_development_content(apply: boolean, all_content_objects = false) {
  const config = runtime_config()
  const production = load_config({ ... process.env, NODE_ENV: 'production', NUXT_OTP_DEBUG: 'false', NUXT_CAPTCHA_DEBUG: 'false' })
  assert.ok(config.aliyun.oss && production.aliyun.oss)
  assert_development_reset(process.env.NODE_ENV, config.db.name,
    configured_reset_buckets(config), configured_reset_buckets(production), config.db.host)
  const connection = await mysql.createConnection({ host: config.db.host, port: config.db.port, user: config.db.user, password: config.db.password, database: config.db.name, timezone: 'Z' })
  try {
    const [tables] = await connection.execute<RowDataPacket[]>('SELECT table_name AS name FROM information_schema.tables WHERE table_schema = DATABASE() AND LEFT(table_name, 8) = \'content_\'')
    const names = tables.map(row => String(row.name)).sort()
    assert.ok(names.every(name => /^content_[a-z_]+$/.test(name)))
    const counts: Record<string, number> = {}
    for (const name of names) {
      const [rows] = await connection.query<RowDataPacket[]>(`SELECT COUNT(*) AS count FROM \`${name}\``)
      counts[name] = Number(rows[0]!.count)
    }
    const [attachments] = await connection.execute<(RowDataPacket & Parameters<typeof reset_attachment_objects>[0])[]>('SELECT object_key, original_key, avif_key, jpeg_key, redacted_avif_key, redacted_jpeg_key, storage_provider, storage_bucket FROM content_story_attachments WHERE object_key IS NOT NULL')
    const [staging] = await connection.execute<RowDataPacket[]>('SELECT staging_key, staging_provider, staging_bucket, upload_id FROM content_task_items WHERE staging_key IS NOT NULL')
    const [attempts] = await connection.execute<RowDataPacket[]>('SELECT a.target_key, a.upload_id, s.target_location FROM content_transfer_attempts a JOIN content_transfer_sessions s ON s.id = a.session_id')
    const objects: ResetObject[] = [
      ... attachments.flatMap(reset_attachment_objects),
      ... staging.map(row => ({ key: String(row.staging_key), location: row.staging_provider === 'aliyun' ? 'aliyun' as const : row.staging_bucket as 'public' | 'private', upload_id: row.upload_id ? String(row.upload_id) : undefined })),
      ... attempts.map(row => ({ key: String(row.target_key), location: row.target_location === 'aliyun' ? 'aliyun' as const : row.target_location === 'legacy_public' ? 'public' as const : 'private' as const, upload_id: row.upload_id ? String(row.upload_id) : undefined })),
    ]
    if (names.includes('content_image_attempts')) {
      const [image_attempts] = await connection.execute<(RowDataPacket & Parameters<typeof reset_image_attempt_objects>[0])[]>('SELECT id, job_id, avif_key, jpeg_key FROM content_image_attempts')
      objects.push(... image_attempts.flatMap(reset_image_attempt_objects))
      const [jobs] = await connection.execute<RowDataPacket[]>('SELECT intent FROM content_image_jobs')
      for (const job of jobs) {
        const intent = typeof job.intent === 'string' ? JSON.parse(job.intent) : job.intent
        if (intent?.input?.key)
          objects.push({ key: intent.input.key, location: 'aliyun' })
      }
    }
    if (names.includes('content_object_retirements')) {
      const [retired] = await connection.execute<RowDataPacket[]>('SELECT object_key FROM content_object_retirements')
      objects.push(... retired.map(row => ({ key: String(row.object_key), location: 'aliyun' as const })))
    }
    if (all_content_objects) {
      objects.push(... await inventory_aliyun_content(new OSS({ ... config.aliyun.oss, secure: true, authorizationV4: true })))
      for (const location of ['public', ... (config.oss.buckets.private ? ['private'] as const : [])] as const) {
        if (location === 'public' && config.oss.bucket === config.aliyun.oss.bucket && config.oss.endpoint === config.aliyun.oss.endpoint)
          continue
        for (const prefix of ['content/', 'content-upload/']) {
          objects.push(... (await list_objects(location, prefix)).map(object => ({ key: object.key, location })))
          objects.push(... (await list_multipart_uploads(location, prefix)).map(object => ({ key: object.key, location, upload_id: object.upload_id })))
        }
      }
    }
    objects.forEach((object) => {
      assert_reset_object(object)
      assert.ok(object.location !== 'private' || config.oss.buckets.private, 'Tracked objects require the legacy private bucket')
    })
    const [stories] = await connection.execute<RowDataPacket[]>('SELECT id FROM content_stories ORDER BY id')
    console.log(JSON.stringify({ apply, all_content_objects, database: config.db.name, counts, tracked_objects: objects.length, unique_keys: new Set(objects.map(object => `${object.location}:${object.key}`)).size }))
    if (! apply)
      return
    const directory = resolve('.nuxt/content-reset')
    await mkdir(directory, { recursive: true })
    const manifest = resolve(directory, `${randomUUID()}.json`)
    await writeFile(manifest, JSON.stringify({ database: config.db.name, buckets: configured_reset_buckets(config), objects, counts }, null, 2))
    await connection.beginTransaction()
    try {
      await connection.execute('SELECT revision FROM content_title_namespace WHERE id = 1 FOR UPDATE')
      await connection.execute('SELECT id FROM content_stories ORDER BY id FOR UPDATE')
      for (const name of names.filter(name => name !== 'content_title_namespace'))
        await connection.query(`DELETE FROM \`${name}\``)
      await connection.execute('UPDATE content_title_namespace SET revision = revision + 1, revision_floor = revision + 1 WHERE id = 1')
      await connection.commit()
    }
    catch (error) {
      await connection.rollback()
      throw error
    }
    console.log(JSON.stringify({ stage: 'database-cleared', manifest }))
    await cleanup_manifest(manifest)
    const { get_mqtt_client } = await import('@server/lib/mqtt')
    const mqtt = get_mqtt_client()
    try {
      if (mqtt && ! mqtt.connected) {
        await new Promise<void>((resolve, reject) => {
          let timer: ReturnType<typeof setTimeout>
          const connected = () => {
            clearTimeout(timer)
            resolve()
          }
          timer = setTimeout(() => {
            mqtt.off('connect', connected)
            reject(new Error('Content reset sync connection timed out'))
          }, mqtt.options.connectTimeout)
          mqtt.once('connect', connected)
        })
      }
      const { publish_refresh, sync_resource } = await import('@server/lib/sync')
      publish_refresh({ resource: sync_resource('content_stories', 'all') })
      publish_refresh({ resource: sync_resource('content_titles', 'all') })
      for (const story of stories) {
        for (const type of ['content_story', 'content_attachments', 'content_uploads'] as const)
          publish_refresh({ resource: sync_resource(type, Number(story.id)) })
      }
      await mqtt?.endAsync()
    }
    catch {
      mqtt?.end(true)
      console.log(JSON.stringify({ stage: 'sync-notification-failed', refresh_required: true }))
    }
  }
  finally {
    await connection.end()
  }
}

async function cleanup_manifest(path: string) {
  const config = runtime_config()
  const production = load_config({ ... process.env, NODE_ENV: 'production', NUXT_OTP_DEBUG: 'false', NUXT_CAPTCHA_DEBUG: 'false' })
  assert_development_reset(process.env.NODE_ENV, config.db.name,
    configured_reset_buckets(config), configured_reset_buckets(production), config.db.host)
  assert.ok(resolve(path).startsWith(`${resolve('.nuxt/content-reset')}/`) || resolve(path).startsWith(`${resolve('.nuxt/content-reset')}\\`), 'Manifest must stay inside the development reset directory')
  const manifest = JSON.parse(await readFile(path, 'utf8')) as { database: string, buckets: string[], objects: ResetObject[] }
  assert.equal(manifest.database, config.db.name)
  assert.deepEqual(manifest.buckets, configured_reset_buckets(config))
  manifest.objects.forEach((object) => {
    assert_reset_object(object)
    assert.ok(object.location !== 'private' || config.oss.buckets.private, 'Tracked objects require the legacy private bucket')
  })
  const unique = [... new Map(manifest.objects.map(object => [`${object.location}:${object.key}:${object.upload_id ?? ''}`, object])).values()]
  const storage = create_aliyun_oss()
  let failed = 0
  for (const object of unique) {
    assert_reset_object(object)
    try {
      if (object.upload_id) {
        try {
          if (object.location === 'aliyun')
            await storage.abort_multipart_upload(object.key, object.upload_id)
          else
            await abort_multipart_upload(object.location, object.key, object.upload_id)
        }
        catch (error) {
          if ((error as { status?: number }).status !== 404 && (error as { name?: string }).name !== 'NoSuchUpload')
            throw error
        }
      }
      if (object.location === 'aliyun')
        await storage.soft_delete_object(object.key)
      else
        await delete_object(object.location, object.key)
    }
    catch (error) {
      const value = error as { status?: number, statusCode?: number, code?: string, name?: string }
      if (value.status === 404 || value.statusCode === 404 || ['NoSuchKey', 'NoSuchUpload'].includes(value.code ?? value.name ?? ''))
        continue
      failed ++
      console.log(JSON.stringify({ stage: 'cleanup-deferred', location: object.location, status: value.status ?? value.statusCode, code: value.code ?? value.name }))
    }
  }
  console.log(JSON.stringify({ stage: 'object-cleanup', total: unique.length, failed, manifest: path }))
  if (failed)
    process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const manifest = process.argv.find(value => value.startsWith('--manifest='))?.slice('--manifest='.length)
  if (manifest)
    await cleanup_manifest(resolve(manifest))
  else
    await reset_development_content(process.argv.includes('--apply'), process.argv.includes('--all-content-objects'))
}
