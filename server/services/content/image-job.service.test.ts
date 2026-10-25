import type { create_aliyun_oss } from '@server/lib/aliyun-oss'
import type { Pool } from 'mysql2/promise'
import type { ImageJobIntent } from './image-job.service'
import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import sharp from 'sharp'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@server/lib/db', () => ({ db: {} }))
vi.mock('@config/loader', () => ({ runtime_config: () => ({ aliyun: {
  oss: { bucket: 'dev', endpoint: 'https://oss.example.test' }, esa: { baseUrl: 'https://edge.example.test' }, esaPurge: { siteId: '123' },
}, app: { contentPreload: { enabled: true, maxObjectBytes: 20971520 } } }) }))
const { create_image_jobs, image_job_intent_schema } = await import('./image-job.service')
const { image_original_key } = await import('./image-original-object')
const base = {
  scope_id: 1, actor_id: 1, mode: 'upload', is_private: false, source: null,
  input: { key: 'content/att/staging/abc/def', etag: 'etag', version_id: 'version', size: 20, sha256: 'a'.repeat(64) },
  original_name: 'image.png', original_mime: 'image/png', profile_version: 1,
  profile: { maxInputBytes: 100, maxPixels: 100, avifQuality: 60, avifEffort: 0, jpegQuality: 85, jpegBackground: '#ffffff', lqipMaxDimension: 24, lqipQuality: 30, timeoutSeconds: 10 },
}
describe('durable image intent', () => {
  it('requires a confidential source for redaction and preserves privacy on ordinary copies', () => {
    expect(image_job_intent_schema.safeParse(base).success).toBe(true)
    expect(image_job_intent_schema.safeParse({ ... base, mode: 'redacted' }).success).toBe(false)
    const source = { id: 2, revision: 1, node_revision: 3, key: 'content/att/images/a.avif', is_private: true }
    expect(image_job_intent_schema.safeParse({ ... base, mode: 'redacted', source }).success).toBe(true)
    expect(image_job_intent_schema.safeParse({ ... base, mode: 'redacted', source, is_private: true }).success).toBe(false)
    expect(image_job_intent_schema.safeParse({ ... base, mode: 'copy', source }).success).toBe(false)
    expect(image_job_intent_schema.safeParse({ ... base, mode: 'copy', source, is_private: true }).success).toBe(true)
  })
  it('does not accept arbitrary external input URLs or invalid encoding profiles', () => {
    expect(image_job_intent_schema.safeParse({ ... base, input: { ... base.input, key: 'https://other/secret' } }).success).toBe(false)
    expect(image_job_intent_schema.safeParse({ ... base, profile: { ... base.profile, avifEffort: 99 } }).success).toBe(false)
  })
})

async function pipeline() {
  const bytes = await sharp({ create: { width: 4, height: 3, channels: 3, background: '#449988' } }).png().toBuffer()
  const input = { ... base.input, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
  const objects = new Map([[input.key, { bytes, etag: input.etag, version_id: input.version_id }]])
  let copy_fault: 'none' | 'lost' | 'corrupt' = 'none'
  let state = {
    job: { id: 'c'.repeat(32), scope_id: 1, status: 'queued', execution_epoch: 0, executor_id: null as string | null, active_attempt_id: null as string | null,
      intent: { ... base, input, profile: { ... base.profile, maxInputBytes: 1000 } } as ImageJobIntent,
      result: null as Record<string, unknown> | null, attachment_id: null as number | null },
    attempts: [] as { id: string, job_id: string, avif_key: string, jpeg_key: string, cleanup_required: number, adopted: number }[],
    attachment: { id: 2, story_id: 1, object_key: input.key, storage_provider: 'aliyun', encryption_key: null, node_revision: 1, is_private: 0, original_key: null } as Record<string, unknown>,
    retired: [] as string[],
    preloads: [] as string[],
    events: [] as { resource: string }[],
  }
  let snapshot = structuredClone(state)
  const execute = vi.fn(async (sql: string, values: unknown[] = []): Promise<unknown[]> => {
    if (sql.includes('FROM content_upload_images'))
      return [[{ session_id: 'a'.repeat(32) }]]
    if (sql.startsWith('INSERT INTO content_sync_outbox')) {
      state.events.push(JSON.parse(String(values[2])))
      return [{ affectedRows: 1 }]
    }
    if (sql.startsWith('INSERT IGNORE INTO content_preload_sites'))
      return [{ affectedRows: 1 }]
    if (sql.startsWith('INSERT IGNORE INTO content_preload_jobs')) {
      if (! state.preloads.includes(String(values[3])))
        state.preloads.push(String(values[3]))
      return [{ affectedRows: 1 }]
    }
    if (sql.includes('FROM content_object_retirements'))
      return [state.retired.includes(String(values[0])) ? [{ object_key: values[0] }] : []]
    if (sql.includes('FROM content_stories'))
      return [[{ id: 1 }]]
    if (sql.includes('FROM users'))
      return [[{ id: 1, is_admin: 1, is_banned: 0 }]]
    if (sql.includes('FROM content_image_jobs'))
      return [[structuredClone(state.job)]]
    if (sql.includes('FROM content_image_attempts a'))
      return [state.attempts.filter(a => ! a.adopted && a.cleanup_required && (a.id !== state.job.active_attempt_id || ['failed', 'cancelled'].includes(state.job.status))).map(a => ({ ... a, scope_id: 1 }))]
    if (sql.startsWith('SELECT * FROM content_image_attempts'))
      return [state.attempts.filter(a => a.id === values[0] && a.job_id === values[1])]
    if (sql.includes('FROM content_story_attachments')) {
      const live = ['object_key', 'original_key', 'avif_key', 'jpeg_key', 'redacted_avif_key', 'redacted_jpeg_key'].some(key => state.attachment[key] === values[0])
      return [sql.includes('WHERE object_key') ? live ? [state.attachment] : [] : [structuredClone(state.attachment)]]
    }
    if (sql.startsWith('INSERT INTO content_image_attempts')) {
      state.attempts.push({ id: String(values[0]), job_id: String(values[1]), avif_key: String(values[3]), jpeg_key: String(values[4]), cleanup_required: 1, adopted: 0 })
    }
    else if (sql.startsWith('UPDATE content_image_attempts SET cleanup_required')) {
      state.attempts.filter(a => ! a.adopted).forEach(a => a.cleanup_required = 1)
    }
    else if (sql.startsWith('UPDATE content_image_attempts SET adopted')) {
      Object.assign(state.attempts.find(a => a.id === values[0])!, { adopted: 1, cleanup_required: 0 })
    }
    else if (sql.includes('SET status = \'processing\', execution_epoch')) {
      Object.assign(state.job, { status: 'processing', execution_epoch: values[0], executor_id: values[1], active_attempt_id: values[2], result: null })
    }
    else if (sql.includes('WHERE id = ? AND execution_epoch = ?')) {
      if (state.job.status !== 'processing' || state.job.execution_epoch !== values.at(- 2) || state.job.executor_id !== values.at(- 1))
        return [{ affectedRows: 0 }]
      if (sql.includes('SET status = \'ready\'') || sql.includes('SET status = \'failed\''))
        Object.assign(state.job, { status: sql.includes('SET status = \'ready\'') ? 'ready' : 'failed', result: JSON.parse(String(values[0])), executor_id: null })
    }
    else if (sql.includes('SET status = \'cancelled\'')) {
      Object.assign(state.job, { status: 'cancelled', execution_epoch: state.job.execution_epoch + 1, executor_id: null })
    }
    else if (sql.includes('SET status = \'queued\'')) {
      Object.assign(state.job, { status: 'queued', result: null, intent: JSON.parse(String(values[0])) })
    }
    else if (sql.includes('SET status = \'completed\'')) {
      Object.assign(state.job, { status: 'completed', attachment_id: values[0] })
    }
    else if (sql.startsWith('UPDATE content_story_attachments SET redacted_avif_key = NULL')) {
      Object.assign(state.attachment, { redacted_avif_key: null, redacted_jpeg_key: null, redacted_metadata: null,
        redacted_revision: Number(state.attachment.redacted_revision ?? 0) + 1 })
    }
    else if (sql.startsWith('UPDATE content_story_attachments SET redacted_avif_key')) {
      Object.assign(state.attachment, { redacted_avif_key: values[0], redacted_jpeg_key: values[1], redacted_metadata: JSON.parse(String(values[2])),
        redacted_lqip_jpeg: values[3], redacted_revision: Number(state.attachment.redacted_revision ?? 0) + 1,
        node_revision: Number(state.attachment.node_revision) + 1 })
    }
    else if (sql.startsWith('UPDATE content_story_attachments SET original_key')) {
      Object.assign(state.attachment, { original_key: values[0], avif_key: values[1], jpeg_key: values[2], parent_avif_key: values[3], image_metadata: JSON.parse(String(values[5])), object_key: values[7],
        node_revision: Number(state.attachment.node_revision) + 1, image_revision: Number(state.attachment.image_revision ?? 0) + 1 })
    }
    else if (sql.startsWith('INSERT IGNORE INTO content_object_retirements')) {
      if (! state.retired.includes(String(values[0])))
        state.retired.push(String(values[0]))
    }
    else if (sql.startsWith('UPDATE content_object_retirements')) { /* Shared re-arm is covered by the retirement integration contract. */ }
    else {
      throw new Error(`Unhandled SQL: ${sql}`)
    }
    return [{ affectedRows: 1 }]
  })
  const connection = {
    execute,
    beginTransaction: async () => { snapshot = structuredClone(state) },
    commit: vi.fn(),
    rollback: async () => { state = snapshot },
    release: vi.fn(),
  }
  const storage = {
    head_object: vi.fn(async (key: string) => {
      const object = objects.get(key)
      if (! object)
        throw Object.assign(new Error('missing'), { status: 404 })
      return { etag: object.etag, version_id: object.version_id, size: object.bytes.length }
    }),
    get_object_access: vi.fn().mockResolvedValue('private'),
    get_object_stream: vi.fn(async (key: string) => ({ stream: Readable.from([objects.get(key)!.bytes]), size: objects.get(key)!.bytes.length })),
    put_object: vi.fn(async (key: string, body: Uint8Array) => {
      const etag = createHash('md5').update(body).digest('hex')
      objects.set(key, { bytes: Buffer.from(body), etag, version_id: key })
      return { etag, version_id: key }
    }),
    copy_object: vi.fn(async (source: string, target: string) => {
      await storage.put_object(target, copy_fault === 'corrupt' ? Buffer.alloc(bytes.length) : objects.get(source)!.bytes)
      if (copy_fault === 'lost')
        throw new Error('copy acknowledgement lost')
      return { etag: objects.get(target)!.etag, version_id: target }
    }),
    soft_delete_object: vi.fn(async (key: string) => { objects.delete(key) }),
  }
  const jobs = create_image_jobs({ getConnection: async () => connection } as unknown as Pool, storage as unknown as ReturnType<typeof create_aliyun_oss>, 60, 10)
  async function adopt(node_revision = 1) {
    await connection.beginTransaction()
    try {
      await jobs.adopt(connection as unknown as Awaited<ReturnType<Pool['getConnection']>>, state.job.id, 1, 2, node_revision)
      await connection.commit()
    }
    catch (error) {
      await connection.rollback()
      throw error
    }
  }
  return {
    jobs, adopt, input, bytes, objects, storage, connection,
    get state() { return state },
    fault: (fault: typeof copy_fault) => copy_fault = fault,
  }
}

it('publishes the verified original with both variants and retires the staging input only in the adoption transaction', async () => {
  const f = await pipeline()
  await f.jobs.run(f.state.job.id, 1)
  expect(f.state.events.map(event => event.resource).sort()).toEqual([
    `content_upload_session:${'a'.repeat(32)}`, `content_upload_session:${'a'.repeat(32)}`,
    'content_uploads:1', 'content_uploads:1',
  ])
  const key = image_original_key(f.state.job.id, f.state.job.active_attempt_id!)
  expect(f.state.job.result?.original).toMatchObject({ key, sha256: f.input.sha256, size: f.input.size })
  expect(f.objects.get(key)!.bytes).toEqual(f.bytes)
  expect(f.state.retired).toEqual([])
  await f.adopt()
  expect(f.state.attachment.original_key).toBe(key)
  expect(f.state.attachment.image_metadata).toMatchObject({ original: { key, name: 'image.png', mime: 'image/png' } })
  expect(f.state.retired).toEqual([f.input.key])
  expect(f.connection.execute.mock.calls.find(([sql]) => sql.startsWith('INSERT IGNORE INTO content_object_retirements'))?.[1])
    .toEqual([f.input.key, 1, 'image-input', 'dev', 'https://oss.example.test', '123', 'https://edge.example.test'])
  expect(f.state.job.status).toBe('completed')
  expect(f.state.preloads).toEqual([f.state.attachment.avif_key, f.state.attachment.jpeg_key])
  expect(f.state.preloads).not.toContain(f.state.attachment.original_key)
  await f.adopt()
  expect(f.state.preloads).toHaveLength(2)
  expect(f.storage.copy_object).toHaveBeenCalledOnce()
  expect(f.state.retired).toEqual([f.input.key])
  await f.jobs.cleanup()
  expect(f.storage.soft_delete_object).not.toHaveBeenCalled()
})

it('publishes a redacted pair on its private owner without changing its normal pixels or archive', async () => {
  const f = await pipeline()
  Object.assign(f.state.attachment, { avif_key: 'private.avif', jpeg_key: 'private.jpg', object_key: 'private.avif', original_key: 'raw', is_private: 1,
    image_revision: 1, redacted_avif_key: 'old-redacted.avif', redacted_jpeg_key: 'old-redacted.jpg', redacted_revision: 1 })
  Object.assign(f.state.job.intent, { mode: 'redacted', source: { id: 2, revision: 1, node_revision: 1, key: 'private.avif', is_private: true } })
  await f.jobs.run(f.state.job.id, 1)
  const result = f.state.job.result as { avif: { key: string }, jpeg: { key: string } }
  await f.adopt()
  expect(f.state.attachment).toMatchObject({ id: 2, object_key: 'private.avif', avif_key: 'private.avif', jpeg_key: 'private.jpg', original_key: 'raw',
    is_private: 1, image_revision: 1, redacted_avif_key: result.avif.key, redacted_jpeg_key: result.jpeg.key, redacted_revision: 2 })
  expect(f.state.preloads).toEqual([result.avif.key, result.jpeg.key])
  expect(f.connection.execute.mock.calls.some(([sql]) => sql.startsWith('INSERT INTO content_story_attachments'))).toBe(false)
  expect(f.state.retired).toEqual(['old-redacted.avif', 'old-redacted.jpg', f.input.key])
  await f.adopt()
  expect(f.state.attachment.redacted_revision).toBe(2)
})

it.each(['keep', 'discard'] as const)('honors the %s decision when overwriting normal pixels', async (policy) => {
  const f = await pipeline()
  Object.assign(f.state.attachment, { avif_key: 'normal.avif', jpeg_key: 'normal.jpg', object_key: 'normal.avif', original_key: 'raw', image_revision: 1,
    redacted_avif_key: 'redacted.avif', redacted_jpeg_key: 'redacted.jpg', redacted_revision: 1 })
  Object.assign(f.state.job.intent, { mode: 'overwrite', source: { id: 2, revision: 1, node_revision: 1, key: 'normal.avif', is_private: false }, redacted_policy: policy })
  await f.jobs.run(f.state.job.id, 1)
  await f.adopt()
  expect(f.state.attachment.original_key).toBe('raw')
  expect(f.state.attachment.redacted_avif_key).toBe(policy === 'keep' ? 'redacted.avif' : null)
  expect(f.state.retired.includes('redacted.avif')).toBe(policy === 'discard')
})

async function copy_pipeline() {
  const f = await pipeline()
  const source = { id: 77, story_id: 1, storage_provider: 'aliyun', encryption_key: null, is_private: 0,
    object_key: 'source.avif', avif_key: 'source.avif', image_revision: 1, node_revision: 1, original_key: 'source-original' }
  f.state.job.intent.mode = 'copy'
  f.state.attachment.file_name = 'docs/副本.avif'
  f.state.job.intent.source = { id: 77, revision: 1, node_revision: 1, key: source.avif_key, is_private: false }
  const execute = f.connection.execute.getMockImplementation()!
  f.connection.execute.mockImplementation(async (sql, values = []) => {
    if (sql.includes('FROM content_story_attachments') && Number(values[0]) === source.id)
      return [[structuredClone(source)]]
    return execute(sql, values)
  })
  return { f, source }
}

it('publishes an independent edited copy with its own initial AVIF archive and no source pointers', async () => {
  const { f, source } = await copy_pipeline()
  await f.jobs.run(f.state.job.id, 1)
  const key = image_original_key(f.state.job.id, f.state.job.active_attempt_id!)
  const avif = f.state.job.result!.avif as { key: string, size: number, sha256: string }
  expect(f.state.job.result?.original).toMatchObject({ key, size: avif.size, sha256: avif.sha256 })
  expect(key).not.toBe(avif.key)
  expect(f.objects.get(key)?.bytes).toEqual(f.objects.get(avif.key)?.bytes)
  expect(f.storage.copy_object).toHaveBeenCalledExactlyOnceWith(avif.key, key, 'private')
  await f.adopt()
  expect(f.state.attachment).toMatchObject({ original_key: key, avif_key: avif.key, jpeg_key: expect.stringMatching(/\.jpg$/), parent_avif_key: null,
    image_metadata: { original: { key, name: '副本.avif', mime: 'image/avif' }, source_id: null, source_revision: null, archive_source_id: null, archive_source_key: null, redaction_source_id: null } })
  source.original_key = 'replaced-source-original'
  source.is_private = 1
  await f.adopt() // Committed replay must not recheck the detached source.
  expect(f.state.attachment.original_key).toBe(key)
  expect(f.storage.copy_object).toHaveBeenCalledOnce()
})

it('still fences a changed source before an independent copy has published', async () => {
  const { f, source } = await copy_pipeline()
  await f.jobs.run(f.state.job.id, 1)
  source.node_revision ++
  await expect(f.adopt()).rejects.toMatchObject({ statusCode: 409 })
  expect(f.state.attachment.original_key).toBeNull()
})

it('keeps the initial copy archive through subsequent overwrite edits and retires only replaced roles', async () => {
  const { f } = await copy_pipeline()
  await f.jobs.run(f.state.job.id, 1)
  await f.adopt()
  const archive = String(f.state.attachment.original_key)
  const initial = Buffer.from(f.objects.get(archive)!.bytes)
  const avif = String(f.state.attachment.avif_key)
  const jpeg = String(f.state.attachment.jpeg_key)
  const input = { ... f.input, key: 'content/att/staging/overwrite/pixels' }
  const uploaded = await f.storage.put_object(input.key, f.bytes)
  Object.assign(input, uploaded)
  Object.assign(f.state.job, { id: 'd'.repeat(32), status: 'queued', result: null })
  Object.assign(f.state.job.intent, { mode: 'overwrite', input,
    source: { id: 2, revision: Number(f.state.attachment.image_revision), node_revision: Number(f.state.attachment.node_revision), key: avif, is_private: false } })
  await f.jobs.run(f.state.job.id, 1)
  expect(f.state.job.result?.original).toBeNull()
  await f.adopt(Number(f.state.attachment.node_revision))
  expect(f.state.attachment.original_key).toBe(archive)
  expect(f.objects.get(archive)?.bytes).toEqual(initial)
  expect(f.state.retired).toEqual(expect.arrayContaining([avif, jpeg, input.key]))
  expect(f.state.retired).not.toContain(archive)
})

it.each(['missing', 'wrong-content'])('refuses a copy archive receipt that is %s', async (fault) => {
  const { f } = await copy_pipeline()
  await f.jobs.run(f.state.job.id, 1)
  if (fault === 'missing')
    f.state.job.result!.original = null
  else
    (f.state.job.result!.original as { sha256: string }).sha256 = f.input.sha256
  await expect(f.adopt()).rejects.toMatchObject({ statusCode: 409 })
  expect(f.state.attachment.original_key).toBeNull()
})

it('rolls back both the original pointer and input retirement when publication fails', async () => {
  const f = await pipeline()
  await f.jobs.run(f.state.job.id, 1)
  f.connection.commit.mockRejectedValueOnce(new Error('commit failed'))
  await expect(f.adopt()).rejects.toThrow('commit failed')
  expect(f.state.attachment.original_key).toBeNull()
  expect(f.state.retired).toEqual([])
  expect(f.state.job.status).toBe('ready')
  expect(f.objects.has(f.input.key)).toBe(true)
})

it.each(['original', 'avif', 'jpeg'])('refuses publication of a retiring image %s role', async (role) => {
  const f = await pipeline()
  await f.jobs.run(f.state.job.id, 1)
  const result = f.state.job.result![role] as { key: string }
  f.state.retired.push(result.key)
  await expect(f.adopt()).rejects.toMatchObject({ statusCode: 409 })
  expect(f.state.attachment.object_key).toBe(f.input.key)
  expect(f.state.job.status).toBe('ready')
})

it.each([
  ['lost', 'upload'], ['corrupt', 'upload'], ['lost', 'copy'], ['corrupt', 'copy'],
] as const)('recovers a %s archive for %s through the attempt ledger and fresh retry keys', async (fault, mode) => {
  const f = mode === 'copy' ? (await copy_pipeline()).f : await pipeline()
  f.fault(fault)
  await expect(f.jobs.run(f.state.job.id, 1)).rejects.toThrow()
  const abandoned = image_original_key(f.state.job.id, f.state.job.active_attempt_id!)
  expect(f.objects.has(abandoned)).toBe(true)
  expect(f.state.job.status).toBe('failed')
  expect(f.state.events.map(event => event.resource).sort()).toEqual([
    `content_upload_session:${'a'.repeat(32)}`, `content_upload_session:${'a'.repeat(32)}`,
    'content_uploads:1', 'content_uploads:1',
  ]) // Processing and failure each commit their upload-only notification.
  await expect(f.adopt()).rejects.toMatchObject({ statusCode: 409 })
  await f.jobs.cleanup()
  expect(f.objects.has(abandoned)).toBe(true)
  expect(f.state.retired).toContain(abandoned)
  expect(f.storage.soft_delete_object).not.toHaveBeenCalled()
  expect(f.objects.has(f.input.key)).toBe(true)
  f.fault('none')
  await f.jobs.retry(f.state.job.id, 1)
  await f.jobs.run(f.state.job.id, 1)
  expect(image_original_key(f.state.job.id, f.state.job.active_attempt_id!)).not.toBe(abandoned)
  await f.adopt()
  expect(f.state.job.status).toBe('completed')
})

it('does not adopt a ready receipt whose original is missing or belongs to another attempt', async () => {
  const f = await pipeline()
  await f.jobs.run(f.state.job.id, 1)
  const original = f.state.job.result!.original as Record<string, unknown>
  f.state.job.result!.original = null
  await expect(f.adopt()).rejects.toMatchObject({ statusCode: 409 })
  f.state.job.result!.original = { ... original, key: f.input.key }
  await expect(f.adopt()).rejects.toMatchObject({ statusCode: 409 })
  expect(f.state.attachment.original_key).toBeNull()
  expect(f.state.retired).toEqual([])
})

it.each(['upload', 'copy'])('fences a %s archive write that finishes after cancellation and cleans it on the next pass', async (mode) => {
  const f = mode === 'copy' ? (await copy_pipeline()).f : await pipeline()
  let release!: () => void
  let reached!: () => void
  const gate = new Promise<void>(resolve => release = resolve)
  const started = new Promise<void>(resolve => reached = resolve)
  const copy = f.storage.copy_object.getMockImplementation()!
  f.storage.copy_object.mockImplementation(async (... args) => {
    reached()
    await gate
    return copy(... args)
  })
  const running = f.jobs.run(f.state.job.id, 1).then(() => null, error => error)
  await Promise.race([started, running.then((error) => {
    throw error ?? new Error('copy did not start')
  })])
  try {
    await f.jobs.cancel(f.state.job.id, 1)
    await f.jobs.cleanup()
  }
  finally {
    release()
  }
  expect(await running).toMatchObject({ statusCode: 409 })
  const key = image_original_key(f.state.job.id, f.state.job.active_attempt_id!)
  expect(f.objects.has(key)).toBe(true)
  expect(f.state.job.status).toBe('cancelled')
  await f.jobs.cleanup()
  expect(f.objects.has(key)).toBe(true)
  expect(f.state.retired).toContain(key)
  expect(f.storage.soft_delete_object).not.toHaveBeenCalled()
  expect(f.objects.has(f.input.key)).toBe(true)
  await expect(f.adopt()).rejects.toMatchObject({ statusCode: 409 })
})
