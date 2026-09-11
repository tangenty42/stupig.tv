// Backfills content_story_attachments from the existing OSS layout
// (content/{story_id}/..., content/0/... = orphan pool). Idempotent via
// INSERT IGNORE; safe to re-run after phase-A deploy to heal mirror gaps.
// Run: node scripts/content-attachments-backfill.mjs

import { ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3'
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

async function list_all_objects(prefix) {
  const objects = []
  let continuation_token
  do {
    const page = await s3.send(new ListObjectsV2Command({
      Bucket: process.env.OSS_BUCKET,
      Prefix: prefix,
      ContinuationToken: continuation_token,
    }))
    objects.push(... (page.Contents ?? []))
    continuation_token = page.IsTruncated ? page.NextContinuationToken : undefined
  } while (continuation_token)
  return objects
}

const [story_rows] = await db.execute('SELECT id FROM content_stories')
const story_ids = new Set(story_rows.map(row => Number(row.id)))

const objects = await list_all_objects('content/')
let inserted = 0
let skipped = 0
const warnings = []

for (const object of objects) {
  const key = object.Key
  if (! key)
    continue
  // content-upload/ is the upload staging area; content/att/ is the new
  // uuid-keyed layout (rows already exist for those).
  if (key.startsWith('content-upload/') || key.startsWith('content/att/'))
    continue
  const match = /^content\/(\d+)\/(.+)$/.exec(key)
  if (! match || match[2].endsWith('/')) {
    skipped += 1
    continue
  }
  const scope = Number(match[1])
  const file_name = match[2]
  let story_id = null
  if (scope !== 0) {
    if (! story_ids.has(scope)) {
      warnings.push(`skipped ${key}: story ${scope} not found`)
      skipped += 1
      continue
    }
    story_id = scope
  }
  const [result] = await db.execute(
    'INSERT IGNORE INTO content_story_attachments (story_id, file_name, object_key, mime_type, file_size, version) VALUES (?, ?, ?, ?, ?, ?)',
    [story_id, file_name, key, null, Number(object.Size ?? 0), strip_etag(object.ETag)],
  )
  if (result.affectedRows > 0)
    inserted += 1
  else
    skipped += 1
}

for (const warning of warnings) {
  console.warn(warning)
}
console.log(`Backfill done: ${inserted} rows inserted, ${skipped} objects skipped (already present or not an attachment).`)

await db.end()
