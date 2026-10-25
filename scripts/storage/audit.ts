import type { StorageBucket } from '@server/lib/storage'
// 旧存储只读盘点：报告 OSS 与数据库不一致的对象，不执行删除。
// 用法：
//   pnpm storage:cleanup                              # 只报告，不改动
//   pnpm storage:cleanup -- --delete                  # 已退休，直接拒绝执行
//   pnpm storage:cleanup -- --grace-hours=168         # 宽限期（小时），默认 168（7 天）
// 覆盖范围：未引用的附件（content/att/）、过期上传暂存（content-upload/ 对象与
// multipart）、过期孤儿附件行（story_id IS NULL）、未引用头像（avatar/）；
// 另报告数据库引用了但 OSS 缺失的附件 key（missing_attachment_keys）。
// 凭据走 config（按环境选择 .env.dev / .env.prod + YAML），无需额外输入。
import type { RowDataPacket } from 'mysql2/promise'
import { runtime_config } from '@config/loader'
import { db } from '@server/lib/db'
import { head_object, list_multipart_uploads, list_objects } from '@server/lib/storage'

interface ReferenceRow extends RowDataPacket {
  id: number
  story_id: number | null
  object_key: string | null
  avatar_file: string | null
  created_at: Date | string
  storage_bucket: StorageBucket
}

interface CleanupCandidate {
  bucket: StorageBucket
  key: string
  last_modified: Date | null
  reason: 'unreferenced_attachment' | 'expired_upload'
}

interface MultipartCandidate {
  bucket: StorageBucket
  key: string
  upload_id: string
  initiated: Date | null
}

interface OrphanDatabaseRow {
  bucket: StorageBucket
  id: number
  object_key: string | null
  created_at: Date | string
}

if (process.argv.includes('--delete'))
  throw new Error('旧回收写入已退休；新会话回收器验收前仅允许只读盘点')
const grace_argument = process.argv.find(argument => argument.startsWith('--grace-hours='))
const grace_hours = grace_argument ? Number(grace_argument.slice('--grace-hours='.length)) : 24 * 7
if (! Number.isFinite(grace_hours) || grace_hours <= 0) {
  throw new Error('--grace-hours 必须是正数')
}

const grace_ms = grace_hours * 60 * 60 * 1000
const now = Date.now()
const is_expired = (date: Date | null) => date !== null && now - date.getTime() >= grace_ms

const [attachment_rows] = await db.execute<ReferenceRow[]>(
  `SELECT object_key, storage_bucket
   FROM content_story_attachments
  WHERE object_key IS NOT NULL AND is_folder = 0 AND story_id IS NOT NULL`,
)
const [orphan_rows] = await db.execute<ReferenceRow[]>(
  `SELECT id, object_key, storage_bucket, created_at
  FROM content_story_attachments
  WHERE story_id IS NULL`,
)
const [avatar_rows] = await db.execute<ReferenceRow[]>(
  'SELECT avatar_file FROM users WHERE avatar_file IS NOT NULL',
)

const [backups] = await db.execute<RowDataPacket[]>('SELECT b.old_object_key, CASE WHEN EXISTS (SELECT 1 FROM content_story_attachments a WHERE a.id = b.attachment_id AND a.storage_bucket = \'private\' AND a.object_key = b.private_object_key AND a.version = b.private_version) THEN b.private_object_key ELSE NULL END AS private_object_key FROM content_attachment_encryption_backup b')
const attachment_keys = new Set(attachment_rows.flatMap(row => row.object_key && row.storage_bucket === 'public' ? [row.object_key] : []))
const private_keys = new Set(attachment_rows.flatMap(row => row.object_key && row.storage_bucket === 'private' ? [row.object_key] : []))
const [migrations] = await db.execute<RowDataPacket[]>('SELECT source_key, target_key FROM content_attachment_storage_migrations WHERE state <> \'retired\'')
for (const row of migrations) {
  attachment_keys.add(String(row.source_key))
  private_keys.add(String(row.target_key))
}
const [staging] = await db.execute<RowDataPacket[]>('SELECT i.staging_key, i.staging_bucket FROM content_task_items i INNER JOIN content_tasks t ON t.id = i.task_id WHERE i.staging_key IS NOT NULL AND i.superseded_at IS NULL AND t.status NOT IN (\'done\', \'cancelled\')')
const active_staging = new Set(staging.map(row => `${row.staging_bucket}:${row.staging_key}`))
// Release-A rollback copies must survive all automatic reconciliation.
for (const backup of backups) {
  attachment_keys.add(String(backup.old_object_key))
  if (backup.private_object_key)
    private_keys.add(String(backup.private_object_key))
}
const avatar_keys = new Set(avatar_rows.flatMap(row => row.avatar_file ? [`avatar/${row.avatar_file}`] : []))
const orphan_database_rows: OrphanDatabaseRow[] = orphan_rows
  .filter(row => is_expired(new Date(row.created_at)))
  .map(row => ({ id: row.id, object_key: row.object_key, bucket: row.storage_bucket, created_at: row.created_at }))

const config = runtime_config()
if (config.aliyun?.oss && config.oss.bucket === config.aliyun.oss.bucket && config.oss.endpoint === config.aliyun.oss.endpoint)
  throw new Error('旧 S3 已退出；此盘点工具仅供使用受保护的历史源配置恢复时运行，当前 OSS 由领域回执和退役流程管理')

const [attachment_objects, upload_objects, multipart_uploads] = await Promise.all([
  list_objects('public', 'content/att/'),
  list_objects('public', 'content-upload/'),
  list_multipart_uploads('public', 'content-upload/'),
])
const private_objects = runtime_config().oss.buckets.private ? await list_objects('private', 'content/att/') : []
const private_upload_objects = runtime_config().oss.buckets.private ? await list_objects('private', 'content-upload/') : []
const private_multipart_uploads = runtime_config().oss.buckets.private ? await list_multipart_uploads('private', 'content-upload/') : []
const copy_multipart_uploads = runtime_config().oss.buckets.private ? await list_multipart_uploads('private', 'content/att/') : []
const private_missing_attachment_keys: string[] = []
if (runtime_config().oss.buckets.private) {
  for (const key of private_keys) {
    try {
      await head_object('private', key)
    }
    catch (error) {
      const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode
      if (status === 404)
        private_missing_attachment_keys.push(key)
      else
        throw error
    }
  }
}

const cleanup_candidates: CleanupCandidate[] = [
  ... attachment_objects
    .filter(object => ! attachment_keys.has(object.key) && is_expired(object.last_modified))
    .map(object => ({ bucket: 'public' as const, key: object.key, last_modified: object.last_modified, reason: 'unreferenced_attachment' as const })),
  ... private_objects
    .filter(object => ! private_keys.has(object.key) && is_expired(object.last_modified))
    .map(object => ({ bucket: 'private' as const, key: object.key, last_modified: object.last_modified, reason: 'unreferenced_attachment' as const })),
  ... upload_objects
    .filter(object => ! active_staging.has(`public:${object.key}`) && is_expired(object.last_modified))
    .map(object => ({ bucket: 'public' as const, key: object.key, last_modified: object.last_modified, reason: 'expired_upload' as const })),
  ... private_upload_objects
    .filter(object => ! active_staging.has(`private:${object.key}`) && is_expired(object.last_modified))
    .map(object => ({ bucket: 'private' as const, key: object.key, last_modified: object.last_modified, reason: 'expired_upload' as const })),
]

const multipart_candidates: MultipartCandidate[] = [
  ... multipart_uploads.map(upload => ({ ... upload, bucket: 'public' as const })),
  ... private_multipart_uploads.map(upload => ({ ... upload, bucket: 'private' as const })),
  ... copy_multipart_uploads.filter(upload => ! private_keys.has(upload.key)).map(upload => ({ ... upload, bucket: 'private' as const })),
].filter(upload => ! active_staging.has(`${upload.bucket}:${upload.key}`) && is_expired(upload.initiated))

const missing_attachment_keys: string[] = []
for (const key of attachment_keys) {
  try {
    await head_object('public', key)
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

const avatar_objects = (await list_objects('public', 'avatar/'))
  .filter(object => ! avatar_keys.has(object.key) && is_expired(object.last_modified))

console.log(JSON.stringify({
  mode: 'report',
  grace_hours,
  missing_attachment_keys,
  private_missing_attachment_keys,
  private_storage_configured: Boolean(runtime_config().oss.buckets.private),
  orphan_database_rows,
  unreferenced_attachment_objects: cleanup_candidates.filter(candidate => candidate.reason === 'unreferenced_attachment'),
  expired_upload_objects: cleanup_candidates.filter(candidate => candidate.reason === 'expired_upload'),
  expired_multipart_uploads: multipart_candidates,
  unreferenced_avatar_objects: avatar_objects,
}, null, 2))

await db.end()
