import type { RowDataPacket } from 'mysql2/promise'
import type { MigrationContext } from '../../../scripts/migration/contract'
import type { Source } from './storage'
import { createHash, randomUUID } from 'node:crypto'
import { canonical, digest, json } from './plan'
import { chunked, plaintext } from './storage'

export interface Identity { key: string, etag: string, size: number, version_id: string | null, sha256: string }
interface ObjectRow extends RowDataPacket {
  id: string
  source_identity: unknown
  target_key: string
  upload_id: string | null
  part_size: number
  parts: Part[] | string
  expected_sha256: string | null
  expected_size: number | null
  result: Identity | string | null
  state: string
}
interface Part { part_number: number, size: number, sha256: string, etag: string | null }

async function target_identity(ctx: MigrationContext, key: string, sha256: string, size: number): Promise<Identity> {
  const storage = await ctx.oss()
  const before = await storage.head_object(key)
  if (before.size !== size || await storage.get_object_access(key) !== 'private')
    throw new Error('target_size_or_access')
  const { stream } = await storage.get_object_stream(key, before.etag, ctx.signal)
  const hash = createHash('sha256')
  let total = 0
  try {
    for await (const bytes of stream) {
      hash.update(bytes)
      total += bytes.length
      ctx.signal.throwIfAborted()
    }
  }
  finally { stream.destroy() }
  if (total !== size || hash.digest('hex') !== sha256 || canonical(await storage.head_object(key)) !== canonical(before))
    throw new Error('target_digest_or_version')
  return { key, ... before, sha256 }
}
export async function verify_object(ctx: MigrationContext, value: Identity) {
  const actual = await target_identity(ctx, value.key, value.sha256, value.size)
  if (actual.etag !== value.etag || actual.version_id !== value.version_id)
    throw new Error('target_changed_after_verification')
}

/** One immutable target per role, exact input identity, and durable multipart receipt. */
export async function copy_object(ctx: MigrationContext, input: {
  scope: number
  attachment: number
  role: string
  provider: 'legacy' | 'aliyun' | 'generated'
  source_key: string | null
  source: Source | null
  encryption_key: string | null
  bytes?: Buffer
  mime: string
  part_size: number
  profile?: string
}): Promise<Identity> {
  const id = digest(`${ctx.filename}:${input.scope}:${input.attachment}:${input.role}`)
  const identity = input.source ? await input.source.head() : { sha256: digest(input.bytes!), size: input.bytes!.length, profile: input.profile ?? null }
  const [existing] = await ctx.db.query<ObjectRow[]>('SELECT * FROM content_migration_objects WHERE id=?', [id])
  let row = existing[0]
  if (! row) {
    const key = `content/att/migrations/${input.scope}/${randomUUID().replaceAll('-', '')}/${input.role}`
    await ctx.db.execute(`INSERT INTO content_migration_objects(id,scope_id,attachment_id,role,source_provider,source_key,source_identity,target_key,part_size,parts)
      VALUES (?,?,?,?,?,?,CAST(? AS JSON),?,?,CAST(? AS JSON))`, [id, input.scope, input.attachment, input.role, input.provider, input.source_key, JSON.stringify(identity), key, input.part_size, '[]'])
    const [[created]] = await ctx.db.query<ObjectRow[]>('SELECT * FROM content_migration_objects WHERE id=?', [id])
    row = created!
  }
  if (canonical(json(row.source_identity)) !== canonical(identity) || Number(row.part_size) !== input.part_size)
    throw new Error('migration_source_or_profile_changed')
  if (row.state === 'verified') {
    const result = json<Identity>(row.result!)
    await verify_object(ctx, result)
    return result
  }
  const storage = await ctx.oss()
  let present = false
  try {
    await storage.head_object(row.target_key)
    present = true
  }
  catch (error) {
    if (Number((error as { status?: number }).status) !== 404)
      throw error
  }
  if (present && ! row.expected_sha256)
    throw new Error('unknown_target_requires_reconciliation')
  let result: Identity
  if (present) {
    result = await target_identity(ctx, row.target_key, row.expected_sha256!, Number(row.expected_size))
  }
  else {
    const expected_size = input.source ? Number((identity as { size: number }).size) - (input.encryption_key ? 28 : 0) : input.bytes!.length
    if (expected_size < 0 || Math.ceil(expected_size / input.part_size) > 10000)
      throw new Error('migration_object_size')
    const stream = input.source
      ? plaintext(input.source, identity as Awaited<ReturnType<Source['head']>>, input.encryption_key, ctx.signal)
      : (async function* () {
          yield input.bytes!
        })()
    const parts = json<Part[]>(row.parts)
    if (expected_size) {
      if (! row.upload_id) {
        const unknown = await storage.list_multipart_uploads(row.target_key)
        if (unknown.length > 1)
          throw new Error('ambiguous_multipart_requires_reconciliation')
        row.upload_id = unknown[0] ?? await storage.create_multipart_upload(row.target_key, input.mime)
        await ctx.db.execute('UPDATE content_migration_objects SET upload_id=? WHERE id=?', [row.upload_id, id])
      }
      const server_parts = new Map<number, { etag: string, size: number }>()
      for (let marker = 0; ;) {
        // NoSuchUpload + no target remains unknown: never blindly overwrite a possibly late Complete.
        const page = await storage.list_multipart_parts(row.target_key, row.upload_id, marker)
        for (const part of page.parts) server_parts.set(part.part_number, part)
        if (page.next_marker === null)
          break
        marker = page.next_marker
      }
      const hash = createHash('sha256')
      let size = 0
      let number = 0
      for await (const bytes of chunked(stream, input.part_size)) {
        const sha256 = digest(bytes)
        hash.update(bytes)
        size += bytes.length
        number ++
        const previous = parts[number - 1]
        if (previous && (previous.sha256 !== sha256 || previous.size !== bytes.length))
          throw new Error('migration_part_input_changed')
        const part: Part = previous ?? { part_number: number, size: bytes.length, sha256, etag: null }
        parts[number - 1] = part
        await ctx.db.execute('UPDATE content_migration_objects SET parts=CAST(? AS JSON) WHERE id=?', [JSON.stringify(parts), id])
        const server = server_parts.get(number)
        if (! part.etag || server?.etag !== part.etag || server.size !== bytes.length) {
          part.etag = (await storage.upload_part(row.target_key, row.upload_id, number, bytes)).etag
          await ctx.db.execute('UPDATE content_migration_objects SET parts=CAST(? AS JSON) WHERE id=?', [JSON.stringify(parts), id])
        }
      }
      const sha256 = hash.digest('hex')
      if (size !== expected_size || number !== parts.length || (row.expected_sha256 && row.expected_sha256 !== sha256))
        throw new Error('migration_plaintext_changed')
      await ctx.db.execute('UPDATE content_migration_objects SET expected_sha256=?,expected_size=? WHERE id=?', [sha256, size, id])
      await storage.complete_multipart_upload(row.target_key, row.upload_id, parts.map(part => ({ part_number: part.part_number, etag: part.etag! })), 'private')
      result = await target_identity(ctx, row.target_key, sha256, size)
    }
    else {
      for await (const ignored of stream) {
        if (ignored.length)
          throw new Error('unexpected_nonempty_source')
      }
      const sha256 = digest(Buffer.alloc(0))
      await ctx.db.execute('UPDATE content_migration_objects SET expected_sha256=?,expected_size=0 WHERE id=?', [sha256, id])
      await storage.put_object(row.target_key, Buffer.alloc(0), input.mime, 'private')
      result = await target_identity(ctx, row.target_key, sha256, 0)
    }
  }
  await ctx.db.execute('UPDATE content_migration_objects SET result=CAST(? AS JSON),state=\'verified\' WHERE id=?', [JSON.stringify(result), id])
  return result
}
