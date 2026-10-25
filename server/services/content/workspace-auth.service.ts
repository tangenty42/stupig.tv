import type { AuthUser } from '@server/types/auth'
import type { RowDataPacket } from 'mysql2/promise'
import { ApiError } from '@server/errors/ApiError'
import { db } from '@server/lib/db'
import { has_permission, normalize_permission_grants } from '@shared/permissions'

/** Grants are checked inside each operation, including receipt replay. */
export async function require_workspace_actor(actor_id: number, private_read: boolean, executor = db as Pick<typeof db, 'execute'>) {
  const [rows] = await executor.execute<RowDataPacket[]>('SELECT id, is_admin, is_banned, permissions FROM users WHERE id = ? FOR SHARE', [actor_id])
  const row = rows[0]
  const actor = row ? { id: Number(row.id), is_admin: Boolean(row.is_admin), permissions: normalize_permission_grants(row.permissions) } as AuthUser : null
  if (! row || row.is_banned || ! has_permission(actor, 'content_manage', 'full') || (private_read && ! has_permission(actor, 'content_private', 'read')))
    throw new ApiError(403, '你没有执行此附件操作的权限')
  return actor!
}
