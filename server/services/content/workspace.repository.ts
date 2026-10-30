import type { Connection, ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import type { RedactedVariantRow } from './redacted-variant'
import type { WorkspaceChange } from './workspace-change'
import { createHash } from 'node:crypto'
import { ApiError } from '@server/errors/ApiError'
import { db } from '@server/lib/db'
import { attachment_path_is_private } from '@shared/content-markdown'
import { attachment_name_key } from '@shared/content-workspace'
import { settings } from '@shared/settings'
import { expire_transfer } from './transfer-session.repository'
import { require_workspace_actor } from './workspace-auth.service'
import { enqueue_workspace_change } from './workspace-sync.service'

export interface WorkspaceRow extends RowDataPacket, RedactedVariantRow {
  original_key?: string | null
  avif_key?: string | null
  jpeg_key?: string | null
  image_revision?: number
  id: number
  story_id: number
  parent_id: number | null
  name: string
  name_key: string | null
  file_name: string
  is_folder: number
  node_revision: number
  object_key: string | null
  version: string
  is_private: number
  storage_provider: string
  encryption_key: string | null
  file_size: number
  mime_type: string | null
  oss_version_id: string | null
}
export async function workspace_rows(connection: Connection, scope: number) {
  const [rows] = await connection.execute<WorkspaceRow[]>('SELECT * FROM content_story_attachments WHERE story_id = ? ORDER BY id', [scope])
  if (rows.some(row => row.parent_id === null || row.name_key === null || (! row.is_folder && (row.storage_provider !== 'aliyun' || row.encryption_key !== null))))
    throw new ApiError(503, '此档案尚未完成附件迁移')
  return rows
}
export function subtree(rows: WorkspaceRow[], root: WorkspaceRow) {
  return rows.filter(row => row.id === root.id || (root.is_folder && (! root.file_name || row.file_name.startsWith(`${root.file_name}/`))))
}
export function node_version(rows: WorkspaceRow[], node: WorkspaceRow) {
  return hash_nodes(node.is_folder ? subtree(rows, node) : [node])
}
function hash_nodes(rows: WorkspaceRow[]) {
  return createHash('sha256').update(JSON.stringify(rows.map(row => [Number(row.id), Number(row.parent_id), row.name, Number(row.node_revision), row.object_key, row.version, Number(row.is_private)]))).digest('hex')
}

/** Preserve the exact version bytes while constructing each folder's members once. */
export function workspace_node_versions(rows: WorkspaceRow[]) {
  const folders = new Map(rows.filter(row => row.is_folder).map(row => [row.file_name, row]))
  const members = new Map(rows.map(row => [Number(row.id), [] as WorkspaceRow[]]))
  for (const row of rows) {
    members.get(Number(row.id))!.push(row)
    const segments = row.file_name.split('/')
    for (let depth = 0; depth < segments.length; depth ++) {
      const folder = folders.get(segments.slice(0, depth).join('/'))
      if (folder && folder.id !== row.id)
        members.get(Number(folder.id))!.push(row)
    }
  }
  return new Map([... members].map(([id, nodes]) => [id, hash_nodes(nodes)]))
}
export async function ensure_workspace_root(connection: Connection, scope: number) {
  const rows = await workspace_rows(connection, scope)
  const root = rows.find(row => row.parent_id === 0)
  if (root)
    return Number(root.id)
  if (rows.length)
    throw new ApiError(503, '附件根目录尚未迁移')
  const [result] = await connection.execute<ResultSetHeader>(`INSERT INTO content_story_attachments
    (story_id, parent_id, name, name_key, file_name, is_folder, version, storage_provider)
    VALUES (?, 0, '', '', '', 1, '', 'aliyun')`, [scope])
  return Number(result.insertId)
}
export async function ensure_workspace_folders(connection: Connection, scope: number, path: string) {
  let parent = await ensure_workspace_root(connection, scope)
  let prefix = ''
  for (const name of path.split('/').filter(Boolean)) {
    prefix = prefix ? `${prefix}/${name}` : name
    const [rows] = await connection.execute<WorkspaceRow[]>('SELECT * FROM content_story_attachments WHERE story_id = ? AND parent_id = ? AND name_key = ?', [scope, parent, attachment_name_key(name)])
    if (rows[0]) {
      if (! rows[0].is_folder)
        throw new ApiError(409, '父路径已被文件占用')
      parent = Number(rows[0].id)
    }
    else {
      const [result] = await connection.execute<ResultSetHeader>(`INSERT INTO content_story_attachments
        (story_id, parent_id, name, name_key, file_name, is_folder, is_private, version, storage_provider) VALUES (?, ?, ?, ?, ?, 1, ?, '', 'aliyun')`,
      [scope, parent, name, attachment_name_key(name), prefix, attachment_path_is_private(prefix) ? 1 : 0])
      parent = Number(result.insertId)
    }
  }
  return parent
}
export async function active_reservations(connection: Connection, scope: number) {
  const [expired] = await connection.execute<RowDataPacket[]>(`SELECT id FROM content_transfer_sessions
    WHERE scope_id = ? AND status IN ('queued', 'running', 'uploading', 'verifying')
    AND expires_at <= CURRENT_TIMESTAMP(3) ORDER BY id FOR UPDATE`, [scope])
  const expired_sessions: string[] = []
  for (const row of expired) {
    if (await expire_transfer(connection, String(row.id)))
      expired_sessions.push(String(row.id))
  }
  const [rows] = await connection.execute<RowDataPacket[]>(`SELECT id, target_parent_id, target_name_key, source_attachment_id, replacement_attachment_id, intent, target_path
    FROM content_transfer_sessions WHERE scope_id = ? AND status IN ('queued', 'running', 'uploading', 'verifying')
    AND expires_at > CURRENT_TIMESTAMP(3) ORDER BY id FOR UPDATE`, [scope])
  return { rows, expired_sessions }
}
/** Receipt and effects commit together. Rejected batches keep a replayable rejection only. */
export async function workspace_transaction<T extends { refresh?: WorkspaceChange }>(actor: number, request: string, scope: number, body: unknown, action: (connection: Connection) => Promise<T>, private_read = false) {
  const fingerprint = createHash('sha256').update(JSON.stringify(body)).digest('hex')
  const connection = await db.getConnection()
  let outcome: { value: T } | { error: { message: string, public_data: NonNullable<ApiError['public_data']> } }
  try {
    await connection.beginTransaction()
    const [stories] = await connection.execute<RowDataPacket[]>('SELECT id FROM content_stories WHERE id = ? FOR UPDATE', [scope])
    if (! stories[0])
      throw new ApiError(404, '档案不存在或已被删除')
    await require_workspace_actor(actor, private_read, connection)
    const [receipts] = await connection.execute<RowDataPacket[]>('SELECT fingerprint, result, expires_at <= CURRENT_TIMESTAMP(3) AS expired FROM content_command_receipts WHERE actor_id = ? AND request_id = ? FOR UPDATE', [actor, request])
    if (receipts[0]) {
      if (receipts[0].fingerprint !== fingerprint || receipts[0].expired)
        throw new ApiError(409, '请求内容已变化或请求已过期，请重新确认当前状态')
      outcome = typeof receipts[0].result === 'string' ? JSON.parse(receipts[0].result) : receipts[0].result
    }
    else {
      await connection.query('SAVEPOINT workspace_effects')
      try {
        outcome = { value: await action(connection) }
      }
      catch (error) {
        if (! (error instanceof ApiError) || error.public_data?.code !== 'BATCH_REJECTED')
          throw error
        await connection.query('ROLLBACK TO SAVEPOINT workspace_effects')
        outcome = { error: { message: error.message, public_data: error.public_data } }
      }
      await connection.execute('INSERT INTO content_command_receipts (actor_id, request_id, scope_id, fingerprint, result, expires_at) VALUES (?, ?, ?, ?, CAST(? AS JSON), TIMESTAMPADD(HOUR, ?, CURRENT_TIMESTAMP(3)))',
        [actor, request, scope, fingerprint, JSON.stringify(outcome), settings.app.content.workspace.receiptHours])
    }
    if ('value' in outcome)
      await enqueue_workspace_change(connection, scope, outcome.value.refresh)
    await connection.commit()
  }
  catch (error) {
    await connection.rollback()
    throw error
  }
  finally {
    connection.release()
  }
  if ('error' in outcome)
    throw new ApiError(409, outcome.error.message, outcome.error.public_data)
  return outcome.value
}
