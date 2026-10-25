import type { ImageProcessingOptions } from '@server/lib/image-processing'
import type { MigrationContext } from '../../../scripts/migration/contract'
import type { Identity } from './objects'
import type { Node } from './plan'
import { process_image_variants } from '@server/lib/image-processing'
import { decrypted_attachment_name, normalized_attachment_extension, processable_image_mime } from '@shared/content-markdown'
import { copy_object } from './objects'
import { canonical, digest, node_mime } from './plan'
import { source_for } from './storage'

export interface Converted {
  main: Identity
  original: Identity | null
  avif: Identity | null
  jpeg: Identity | null
  lqip: Buffer | null
  width: number | null
  height: number | null
  mime: string
}
export interface ImageOptions { profile: ImageProcessingOptions, profile_version: number, part_size: number, codec: string }

/** Read only the verified private archive, bounded by the image profile, never an entire large file. */
async function image_bytes(ctx: MigrationContext, identity: Identity, max: number) {
  if (identity.size > max)
    throw new Error('migration_image_too_large')
  const storage = await ctx.oss()
  const { stream } = await storage.get_object_stream(identity.key, identity.etag, ctx.signal)
  const chunks: Buffer[] = []
  let size = 0
  try {
    for await (const chunk of stream) {
      size += chunk.length
      if (size > max)
        throw new Error('migration_image_too_large')
      chunks.push(Buffer.from(chunk))
      ctx.signal.throwIfAborted()
    }
  }
  finally { stream.destroy() }
  const bytes = Buffer.concat(chunks)
  if (bytes.length !== identity.size || digest(bytes) !== identity.sha256)
    throw new Error('migration_archive_changed')
  return bytes
}

export async function convert_node(ctx: MigrationContext, scope: number, row: Node, options: ImageOptions, prefix = ''): Promise<Converted> {
  const mime = node_mime(row) ?? 'application/octet-stream'
  const image = processable_image_mime(mime)
  // Do not reinterpret a partly populated/edited model as an unedited original.
  if (! prefix && (row.original_key || row.avif_key || row.jpeg_key || row.image_metadata))
    throw new Error('migration_partial_image_model')
  const source = await source_for(ctx, row)
  if (image && (await source.head()).size - (row.encryption_key ? 28 : 0) > options.profile.maxInputBytes)
    throw new Error('migration_image_too_large')
  const original = await copy_object(ctx, { scope, attachment: row.id, role: `${prefix}original`, provider: row.storage_provider === 'aliyun' ? 'aliyun' : 'legacy', source_key: row.object_key,
    source, encryption_key: row.encryption_key, mime, part_size: options.part_size })
  if (! image)
    return { main: original, original: null, avif: null, jpeg: null, lqip: null, width: null, height: null, mime }
  const result = await process_image_variants(await image_bytes(ctx, original, options.profile.maxInputBytes), options.profile)
  if (result.lqip.length > 8192)
    throw new Error('migration_lqip_size')
  const profile = digest(canonical(options))
  const output = async (role: string, bytes: Buffer, mime: string) => copy_object(ctx, { scope, attachment: row.id, role: `${prefix}${role}`, provider: 'generated', source_key: null, source: null, encryption_key: null, bytes, mime, part_size: options.part_size, profile })
  const avif = await output('avif', result.avif, 'image/avif')
  const jpeg = await output('jpeg', result.jpeg, 'image/jpeg')
  return { main: avif, original, avif, jpeg, lqip: result.lqip, width: result.width, height: result.height, mime: 'image/avif' }
}

export function image_metadata(result: Converted, row: Node, options: ImageOptions) {
  return { avif: result.avif, jpeg: result.jpeg, width: result.width, height: result.height, profile_version: options.profile_version,
    original: result.original ? { ... result.original, name: normalized_attachment_extension(decrypted_attachment_name(row.file_name)).split('/').at(- 1), mime: node_mime(row) } : null,
    source_id: null, source_revision: null, input_basis: 'original', archive_source_id: null, archive_source_key: null, redaction_source_id: null }
}
