// 存储对账清理：报告 OSS 与数据库不一致的对象，--delete 时实际删除。
// 用法：
//   pnpm storage:cleanup                              # 只报告，不改动
//   pnpm storage:cleanup -- --delete                  # 删除过期孤儿对象并中止过期 multipart
//   pnpm storage:cleanup -- --grace-hours=168         # 宽限期（小时），默认 168（7 天）
// 覆盖范围：未引用的附件（content/att/）、过期上传暂存（content-upload/ 对象与
// multipart）、过期孤儿附件行（story_id IS NULL）、未引用头像（avatar/）；
// 另报告数据库引用了但 OSS 缺失的附件 key（missing_attachment_keys）。
// 凭据走 config（.env + YAML），无需额外输入。README 里有 cron 部署示例。
import type { RowDataPacket } from 'mysql2/promise'
import { db } from '@server/lib/db'
import { abort_multipart_upload, delete_object, head_object, list_multipart_uploads, list_objects } from '@server/lib/storage'

interface ReferenceRow extends RowDataPacket {
  id: number
  story_id: number | null
  object_key: string | null
  avatar_file: string | null
  created_at: Date | string
}

interface CleanupCandidate {
  key: string
  last_modified: Date | null
  reason: 'unreferenced_attachment' | 'expired_upload'
}

interface MultipartCandidate {
  key: string
  upload_id: string
  initiated: Date | null
}

interface OrphanDatabaseRow {
  id: number
  object_key: string | null
  created_at: Date | string
}

const delete_mode = process.argv.includes('--delete')
const grace_argument = process.argv.find(argument => argument.startsWith('--grace-hours='))
const grace_hours = grace_argument ? Number(grace_argument.slice('--grace-hours='.length)) : 24 * 7
if (! Number.isFinite(grace_hours) || grace_hours <= 0) {
  throw new Error('--grace-hours 必须是正数')
}

const grace_ms = grace_hours * 60 * 60 * 1000
const now = Date.now()
const is_expired = (date: Date | null) => date !== null && now - date.getTime() >= grace_ms

const [attachment_rows] = await db.execute<ReferenceRow[]>(
  `SELECT object_key
   FROM content_story_attachments
  WHERE object_key IS NOT NULL AND is_folder = 0 AND story_id IS NOT NULL`,
)
const [orphan_rows] = await db.execute<ReferenceRow[]>(
  `SELECT id, object_key, created_at
  FROM content_story_attachments
  WHERE story_id IS NULL`,
)
const [avatar_rows] = await db.execute<ReferenceRow[]>(
  'SELECT avatar_file FROM users WHERE avatar_file IS NOT NULL',
)

const attachment_keys = new Set(attachment_rows.flatMap(row => row.object_key ? [row.object_key] : []))
const avatar_keys = new Set(avatar_rows.flatMap(row => row.avatar_file ? [`avatar/${row.avatar_file}`] : []))
const orphan_database_rows: OrphanDatabaseRow[] = orphan_rows
  .filter(row => is_expired(new Date(row.created_at)))
  .map(row => ({ id: row.id, object_key: row.object_key, created_at: row.created_at }))

const [attachment_objects, upload_objects, multipart_uploads] = await Promise.all([
  list_objects('content/att/'),
  list_objects('content-upload/'),
  list_multipart_uploads('content-upload/'),
])

const cleanup_candidates: CleanupCandidate[] = [
  ... attachment_objects
    .filter(object => ! attachment_keys.has(object.key) && is_expired(object.last_modified))
    .map(object => ({ key: object.key, last_modified: object.last_modified, reason: 'unreferenced_attachment' as const })),
  ... upload_objects
    .filter(object => is_expired(object.last_modified))
    .map(object => ({ key: object.key, last_modified: object.last_modified, reason: 'expired_upload' as const })),
]

const multipart_candidates: MultipartCandidate[] = multipart_uploads
  .filter(upload => is_expired(upload.initiated))
  .map(upload => ({ key: upload.key, upload_id: upload.upload_id, initiated: upload.initiated }))

const missing_attachment_keys: string[] = []
for (const key of attachment_keys) {
  try {
    await head_object(key)
  }
  catch (error) {
    const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode
    const name = (error as { name?: string }).name
    if (status === 404 || name === 'NotFound' || name === 'NoSuchKey') {
      missing_attachment_keys.push(key)
    }
    else {
      console.warn(`附件 HEAD 检查失败 ${key}:`, error)
    }
  }
}

const avatar_objects = (await list_objects('avatar/'))
  .filter(object => ! avatar_keys.has(object.key) && is_expired(object.last_modified))

console.log(JSON.stringify({
  mode: delete_mode ? 'delete' : 'report',
  grace_hours,
  missing_attachment_keys,
  orphan_database_rows,
  unreferenced_attachment_objects: cleanup_candidates.filter(candidate => candidate.reason === 'unreferenced_attachment'),
  expired_upload_objects: cleanup_candidates.filter(candidate => candidate.reason === 'expired_upload'),
  expired_multipart_uploads: multipart_candidates,
  unreferenced_avatar_objects: avatar_objects,
}, null, 2))

if (! delete_mode) {
  await db.end()
  process.exit(0)
}

const orphan_object_keys = new Set(orphan_database_rows.flatMap(row => row.object_key ? [row.object_key] : []))
for (const key of orphan_object_keys) {
  try {
    await delete_object(key)
  }
  catch (error) {
    console.warn(`数据库 orphan 对象删除失败 ${key}:`, error)
  }
}

if (orphan_database_rows.length) {
  const placeholders = orphan_database_rows.map(() => '?').join(',')
  await db.execute(
    `DELETE FROM content_story_attachments WHERE id IN (${placeholders})`,
    orphan_database_rows.map(row => row.id),
  )
}

let deleted_objects = 0
let failed_objects = 0
for (const candidate of cleanup_candidates) {
  try {
    await delete_object(candidate.key)
    deleted_objects ++
  }
  catch (error) {
    failed_objects ++
    console.warn(`对象删除失败 ${candidate.key}:`, error)
  }
}

let aborted_multipart_uploads = 0
let failed_multipart_uploads = 0
for (const upload of multipart_candidates) {
  try {
    await abort_multipart_upload(upload.key, upload.upload_id)
    aborted_multipart_uploads ++
  }
  catch (error) {
    failed_multipart_uploads ++
    console.warn(`multipart upload 中止失败 ${upload.key} (${upload.upload_id}):`, error)
  }
}

for (const object of avatar_objects) {
  try {
    await delete_object(object.key)
    deleted_objects ++
  }
  catch (error) {
    failed_objects ++
    console.warn(`头像对象删除失败 ${object.key}:`, error)
  }
}

console.log(JSON.stringify({
  deleted_objects,
  failed_objects,
  aborted_multipart_uploads,
  failed_multipart_uploads,
}, null, 2))
await db.end()
process.exit(0)
