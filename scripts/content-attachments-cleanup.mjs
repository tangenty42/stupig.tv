// Deletes legacy-layout objects no row references anymore. Dry-run by default;
// pass --yes to actually delete. Only considers content/ objects outside the
// content/att/ uuid layout (upload staging under content-upload/ is untouched).
// Run: node scripts/content-attachments-cleanup.mjs [--yes]

import { DeleteObjectCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3'
import { config } from 'dotenv'
import mysql from 'mysql2/promise'

config({ quiet: true })

const execute = process.argv.includes('--yes')

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

const [rows] = await db.execute(
  'SELECT object_key FROM content_story_attachments WHERE object_key IS NOT NULL',
)
const referenced = new Set(rows.map(row => row.object_key))

const objects = await list_all_objects('content/')
const orphans = objects.filter(object =>
  object.Key
  && ! object.Key.startsWith('content/att/')
  && ! referenced.has(object.Key))

const total_bytes = orphans.reduce((sum, object) => sum + Number(object.Size ?? 0), 0)
console.log(`${orphans.length} unreferenced legacy objects (${(total_bytes / 1024 / 1024).toFixed(1)} MB).`)
for (const object of orphans) {
  console.log(`  ${object.Key}`)
}

if (! execute) {
  console.log('Dry-run; re-run with --yes to delete these objects.')
}
else {
  let deleted = 0
  for (const object of orphans) {
    await s3.send(new DeleteObjectCommand({
      Bucket: process.env.OSS_BUCKET,
      Key: object.Key,
    }))
    deleted += 1
  }
  console.log(`Deleted ${deleted} objects.`)
}

await db.end()
