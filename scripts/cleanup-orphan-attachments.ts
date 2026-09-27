// One-off cleanup: purges the orphan attachment staging pool (story_id IS
// NULL) — OSS objects first, then every orphan row (files and folders).
// Run: node_modules/.bin/esbuild --bundle --platform=node --format=esm \
//   --alias:@shared=/app/server/shared --alias:@server=/app/server \
//   --outfile=/tmp/cleanup-orphans.mjs scripts/cleanup-orphan-attachments.ts \
//   && node --env-file=.env /tmp/cleanup-orphans.mjs
import type { RowDataPacket } from 'mysql2/promise'
import { db } from '@server/lib/db'
import { delete_object } from '@server/lib/storage'

interface OrphanRow extends RowDataPacket {
  id: number
  file_name: string
  object_key: string | null
}

const [rows] = await db.execute<OrphanRow[]>(
  'SELECT id, file_name, object_key FROM content_story_attachments WHERE story_id IS NULL',
)
console.log(`发现 ${rows.length} 行孤儿池记录`)

let objects = 0
for (const row of rows) {
  if (! row.object_key)
    continue
  await delete_object(row.object_key).catch((ex) => {
    console.warn(`对象删除失败 ${row.object_key}:`, ex)
  })
  objects ++
}
console.log(`已删除 ${objects} 个 OSS 对象`)

const [result] = await db.execute('DELETE FROM content_story_attachments WHERE story_id IS NULL')
console.log(`已删除 ${(result as { affectedRows?: number }).affectedRows ?? 0} 行数据库记录`)
process.exit(0)
