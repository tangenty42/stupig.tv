import type { RowDataPacket } from 'mysql2/promise'
import type { MigrationDatabase } from '../../../scripts/migration/contract'

/** Maintenance is offline: an unresolved old job must never be silently discarded. */
export async function pending_work(db: MigrationDatabase) {
  const [[legacy]] = await db.query<RowDataPacket[]>('SELECT COUNT(*) AS n FROM content_tasks WHERE status NOT IN (\'done\',\'completed\',\'cancelled\')')
  const [[transfers]] = await db.query<RowDataPacket[]>('SELECT COUNT(*) AS n FROM content_transfer_sessions WHERE status IN (\'uploading\',\'queued\',\'running\',\'verifying\')')
  const [[images]] = await db.query<RowDataPacket[]>('SELECT COUNT(*) AS n FROM content_image_jobs WHERE status IN (\'queued\',\'processing\',\'ready\',\'failed\')')
  const [[old_copies]] = await db.query<RowDataPacket[]>('SELECT COUNT(*) AS n FROM content_attachment_storage_migrations WHERE state IN (\'copying\',\'verified\')')
  return { legacy_tasks: Number(legacy!.n), transfers: Number(transfers!.n), image_jobs: Number(images!.n), legacy_copies: Number(old_copies!.n) }
}
export async function require_quiet(db: MigrationDatabase) {
  if (Object.values(await pending_work(db)).some(Boolean))
    throw new Error('content_migration_pending_work')
}
