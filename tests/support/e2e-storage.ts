import type { create_aliyun_oss as ProductionStorage } from '../../server/lib/aliyun-oss'
import { createHash, randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'

// Loaded only by the isolated Nuxt layer. The real upload API, database and
// browser remain in use; this replaces the external OSS network boundary.
const objects = new Map<string, { bytes: Buffer, etag: string, version_id: string }>()
const uploads = new Map<string, { key: string, parts: Map<number, Buffer> }>()
function missing(): never {
  throw Object.assign(new Error('Test object not found'), { status: 404, code: 'NoSuchUpload' })
}
function put(key: string, bytes: Uint8Array) {
  const value = { bytes: Buffer.from(bytes), etag: createHash('md5').update(bytes).digest('hex'), version_id: randomUUID() }
  objects.set(key, value)
  return { etag: value.etag, version_id: value.version_id }
}
export function receive_part(id: string, part: number, bytes: Uint8Array) {
  const upload = uploads.get(id) ?? missing()
  upload.parts.set(part, Buffer.from(bytes))
  return createHash('md5').update(bytes).digest('hex')
}

export function create_aliyun_oss(): ReturnType<typeof ProductionStorage> {
  const environment = process.env
  if (! environment.STUPIG_E2E_RUNTIME || environment.NODE_ENV !== 'development')
    throw new Error('Test storage cannot run outside the isolated development fixture')
  return {
    async head_object(key) {
      const value = objects.get(key) ?? missing()
      return { etag: value.etag, version_id: value.version_id, size: value.bytes.length }
    },
    async put_object(key, bytes) { return put(key, bytes) },
    async create_multipart_upload(key) {
      const id = randomUUID()
      uploads.set(id, { key, parts: new Map() })
      return id
    },
    async upload_part(_key, id, part, bytes) {
      return { part_number: part, etag: receive_part(id, part, bytes), size: bytes.byteLength }
    },
    async signed_part_upload(_key, id, part, size, md5) {
      return { url: `https://e2e.oss.invalid/${_key}?uploadId=${id}&partNumber=${part}`, method: 'PUT', headers: { 'Content-Type': 'application/octet-stream', 'Content-MD5': md5, 'Content-Length': String(size) } }
    },
    async list_multipart_parts(_key, id) {
      const upload = uploads.get(id) ?? missing()
      return { parts: [... upload.parts.entries()].sort(([a], [b]) => a - b).map(([part_number, bytes]) => ({ part_number, size: bytes.length, etag: createHash('md5').update(bytes).digest('hex') })), next_marker: null }
    },
    async list_multipart_uploads(key) { return [... uploads.entries()].filter(([, value]) => value.key === key).map(([id]) => id) },
    async complete_multipart_upload(key, id, parts) {
      const upload = uploads.get(id) ?? missing()
      const result = put(key, Buffer.concat(parts.map(part => upload.parts.get(part.part_number) ?? missing())))
      uploads.delete(id)
      return result
    },
    async abort_multipart_upload(_key, id) { uploads.delete(id) },
    async copy_object(source, target) { return put(target, (objects.get(source) ?? missing()).bytes) },
    async set_object_access() {},
    async get_object_access() { return 'private' },
    async signed_read_url() { throw new Error('Cloud delivery is outside local E2E coverage') },
    async get_object_stream(key) {
      const value = objects.get(key) ?? missing()
      return { stream: Readable.from(value.bytes), size: value.bytes.length }
    },
    async soft_delete_object(key) {
      objects.delete(key)
      return { delete_marker_version_id: randomUUID() }
    },
    async inspect_bucket() { return { acl: 'private', versioning: 'Enabled', lifecycle_rules: [] } },
  }
}
