// Rehomes attachment objects onto uuid keys: copies each non-`content/att/`
// object to content/att/<uuid> and points its row at the new key. Idempotent —
// already-rehomed rows are skipped, so re-run freely. Old objects are NOT
// deleted here; scripts/content-attachments-cleanup.mjs does that afterwards.
// Run: node scripts/content-attachments-rehome.mjs

import { randomUUID } from 'node:crypto'
import { CopyObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { config } from 'dotenv'
import mysql from 'mysql2/promise'

config({ quiet: true })

const required = [
  'DB_HOST', 'DB_PORT', 'DB_USER', 'DB_PASSWORD', 'DB_NAME',
  'OSS_ENDPOINT', 'OSS_REGION', 'OSS_BUCKET', 'OSS_ACCESS_KEY_ID', 'OSS_ACCESS_KEY_SECRET',
]
const missing = required.filter(name => ! process.env[name])
if (missing.length) {
  console.error(`Missing env vars: ${missing.join(', ')}`)
  process.exit(1)
}

const s3 = new S3Client({
  endpoint: process.env.OSS_ENDPOINT,
  region: process.env.OSS_REGION,
  forcePathStyle: process.env.OSS_FORCE_PATH_STYLE === 'true',
  credentials: {
    accessKeyId: process.env.OSS_ACCESS_KEY_ID,
    secretAccessKey: process.env.OSS_ACCESS_KEY_SECRET,
  },
})

const db = mysql.createPool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  timezone: 'Z',
})

function strip_etag(etag) {
  return etag ? etag.replaceAll('"', '') : ''
}

function copy_source(key) {
  return `${process.env.OSS_BUCKET}/${key.split('/').map(encodeURIComponent).join('/')}`
}

const [rows] = await db.execute(
  'SELECT id, object_key FROM content_story_attachments WHERE is_folder = 0 AND object_key NOT LIKE \'content/att/%\'',
)
console.log(`${rows.length} objects to rehome.`)

let done = 0
let failed = 0
for (const row of rows) {
  const new_key = `content/att/${randomUUID()}`
  try {
    const result = await s3.send(new CopyObjectCommand({
      Bucket: process.env.OSS_BUCKET,
      Key: new_key,
      CopySource: copy_source(row.object_key),
      MetadataDirective: 'COPY',
    }))
    // Guard against a concurrent replace having moved the row already.
    const [update] = await db.execute(
      'UPDATE content_story_attachments SET object_key = ?, version = ? WHERE id = ? AND object_key = ?',
      [new_key, strip_etag(result.CopyObjectResult?.ETag) || String(Date.now()), row.id, row.object_key],
    )
    if (update.affectedRows === 0)
      console.warn(`row ${row.id} moved concurrently; orphan copy at ${new_key}`)
    done += 1
    if (done % 10 === 0)
      console.log(`  ${done}/${rows.length}`)
  }
  catch (ex) {
    failed += 1
    console.error(`FAILED row ${row.id} (${row.object_key}):`, ex.message)
  }
}

console.log(`Rehome done: ${done} copied, ${failed} failed.`)
await db.end()
