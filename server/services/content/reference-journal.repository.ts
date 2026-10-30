import type { ContentReferenceChange, ContentReferenceJournal } from '@shared/types/content-reference'
import type { Connection, RowDataPacket } from 'mysql2/promise'
import { ApiError } from '@server/errors/ApiError'
import { content_reference_key } from '@shared/content-reference'
import { settings } from '@shared/settings'

interface JournalRow extends RowDataPacket {
  revision: number
  node_id: number | null
  from_ref: string | null
  to_ref: string | null
  is_folder: number
}

/** Caller holds the scope lock; history, its floor and main commit together. */
export async function append_reference_journal(connection: Connection, scope_id: number, revision: number, changes: ContentReferenceChange[]) {
  // Empty batches still advance catalog/representation freshness and occupy one batch.
  const entries = changes.length ? changes : [{ node_id: 0, from: null, to: null }]
  const values = entries.flatMap((change, index) => [
    scope_id, revision, index, change.node_id, change.from, change.to,
    change.from === null ? null : content_reference_key(change.from),
    change.to === null ? null : content_reference_key(change.to), Boolean(change.is_folder),
  ])
  await connection.execute(`INSERT INTO content_reference_journals
    (scope_id, revision, entry_index, node_id, from_ref, to_ref, from_key, to_key, is_folder)
    VALUES ${entries.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ')}`, values)
  const [expired] = await connection.execute<RowDataPacket[]>(
    'SELECT DISTINCT revision FROM content_reference_journals WHERE scope_id = ? ORDER BY revision DESC LIMIT 1 OFFSET ?',
    [scope_id, settings.app.content.reference.journalBatchLimit],
  )
  if (! expired[0])
    return
  const floor = Number(expired[0].revision)
  if (scope_id === 0)
    await connection.execute('UPDATE content_title_namespace SET revision_floor = GREATEST(revision_floor, ?) WHERE id = 1', [floor])
  else
    await connection.execute('UPDATE content_stories SET namespace_floor = GREATEST(namespace_floor, ?), updated_at = updated_at WHERE id = ?', [floor, scope_id])
  await connection.execute('DELETE FROM content_reference_journals WHERE scope_id = ? AND revision <= ?', [scope_id, floor])
}

export async function reference_journals_since(connection: Connection, scope_id: number, baseline: number | null, current: number, floor: number) {
  const unavailable = baseline === null || baseline < floor || baseline > current
  if (unavailable)
    return { unavailable, journals: [] as ContentReferenceJournal[] }
  const [rows] = await connection.execute<JournalRow[]>(
    'SELECT revision, node_id, from_ref, to_ref, is_folder FROM content_reference_journals WHERE scope_id = ? AND revision > ? AND revision <= ? ORDER BY revision, entry_index',
    [scope_id, baseline, current],
  )
  const batches = new Map<number, ContentReferenceJournal>()
  for (const row of rows) {
    const revision = Number(row.revision)
    const batch = batches.get(revision) ?? { revision, changes: [] }
    batches.set(revision, batch)
    if (row.from_ref !== null || row.to_ref !== null)
      batch.changes.push({ node_id: Number(row.node_id), from: row.from_ref, to: row.to_ref, is_folder: Boolean(row.is_folder) })
  }
  // Attachment mutations have always journaled every revision, including empty
  // batches. Legacy title creation advanced revisions without a journal entry.
  if (scope_id !== 0 && (batches.size !== current - baseline || [... batches.keys()].some((revision, index) => revision !== baseline + index + 1)))
    throw new ApiError(503, '附件引用历史不完整，请核对数据库状态后重试')
  return { unavailable, journals: [... batches.values()] }
}
