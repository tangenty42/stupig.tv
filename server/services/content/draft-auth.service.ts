import type { AuthUser } from '@server/types/auth'
import type { Connection, RowDataPacket } from 'mysql2/promise'
import { ApiError } from '@server/errors/ApiError'
import { has_permission, normalize_permission_grants } from '@shared/permissions'
import { database_now } from './draft.repository'

/** Lock current authorization after content locks; session ids can be revived. */
export async function require_draft_actor(connection: Pick<Connection, 'execute'>, presented: AuthUser) {
  if (! Number.isSafeInteger(presented.token_generation_id))
    throw new ApiError(401, '登录状态无效，请重新登录')
  const [users] = await connection.execute<RowDataPacket[]>('SELECT id, is_admin, is_banned, permissions FROM users WHERE id = ? FOR SHARE', [presented.id])
  const [sessions] = await connection.execute<RowDataPacket[]>('SELECT user_id, is_logged_out, UNIX_TIMESTAMP(expires_at) * 1000 AS expires_ms FROM user_login_sessions WHERE id = ? FOR SHARE', [presented.session_id])
  const [tokens] = await connection.execute<RowDataPacket[]>('SELECT session_id, UNIX_TIMESTAMP(expires_at) * 1000 AS expires_ms FROM user_login_session_tokens WHERE id = ? FOR SHARE', [presented.token_generation_id!])
  // CURRENT_TIMESTAMP inside a waiting locking SELECT is statement-start time.
  // Read the clock only after every authorization row lock has been acquired.
  const now = await database_now(connection)
  const user = users[0]
  const session = sessions[0]
  const token = tokens[0]
  if (! user || user.is_banned || ! session || Number(session.user_id) !== presented.id || session.is_logged_out || ! (Number(session.expires_ms) > now) || ! token || Number(token.session_id) !== presented.session_id || ! (Number(token.expires_ms) > now))
    throw new ApiError(401, '当前登录会话已失效')
  const actor = { ... presented, is_admin: Boolean(user.is_admin), permissions: normalize_permission_grants(user.permissions) }
  if (! has_permission(actor, 'content_manage', 'full') || ! has_permission(actor, 'content_private', 'read'))
    throw new ApiError(403, '编辑云端草稿需要档案管理和机密读取权限')
  return actor
}
