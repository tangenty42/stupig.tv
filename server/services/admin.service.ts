import type { UserRow } from '@server/services/profile.service'

import type { AuthUser } from '@server/types/auth'
import type { AdminUserList } from '@shared/types/api'
import type { H3Event } from 'h3'
import type { RowDataPacket } from 'mysql2/promise'
import { ApiError } from '@server/errors/ApiError'
import { db } from '@server/lib/db'
import { publish_refresh, sync_resource } from '@server/lib/sync'
import { require_auth_user } from '@server/services/auth-guards.service'
import { format_profile_row, select_profile_row_sql } from '@server/services/profile.service'
import { logout_all_user_sessions } from '@server/services/session.service'
import { env } from '@shared/env'

interface CountRow extends RowDataPacket {
  total: number
}

export async function force_logout_user(target_id: number): Promise<void> {
  await logout_all_user_sessions(target_id, null)
  publish_refresh({ resource: sync_resource('auth_user', target_id) })
  publish_refresh({ resource: sync_resource('profile_sessions', target_id) })
}

export async function ban_user(target_id: number): Promise<void> {
  await db.execute(
    'UPDATE users SET is_banned = 1 WHERE id = ?',
    [target_id],
  )
  await logout_all_user_sessions(target_id, null)
  publish_refresh({ resource: sync_resource('auth_user', target_id) })
  publish_refresh({ resource: sync_resource('profile_sessions', target_id) })
}

export async function unban_user(target_id: number): Promise<void> {
  await db.execute(
    'UPDATE users SET is_banned = 0 WHERE id = ?',
    [target_id],
  )
}

export async function list_users(
  viewer: AuthUser,
  options: { page: number, page_size: number, filter?: string },
): Promise<AdminUserList> {
  const { page, page_size } = options
  const offset = (page - 1) * page_size

  const filter = options.filter ? options.filter.trim() : ''
  const where_clause = filter || '1=1'
  const params: string[] = []

  const [count_rows] = await db.execute<CountRow[]>(
    `SELECT COUNT(*) AS total FROM users WHERE ${where_clause}`,
    params,
  )
  const total = count_rows[0]?.total ?? 0

  const [user_rows] = await db.execute<UserRow[]>(
    `${select_profile_row_sql}
     WHERE ${where_clause}
     ORDER BY u.id DESC
     LIMIT ? OFFSET ?`,
    [env.ONLINE_TIMEOUT_SECONDS, ...params, String(page_size), String(offset)],
  )

  return {
    total,
    users: user_rows.map((user) => {
      const profile = format_profile_row(viewer, user, user.id)
      return {
        id: profile.id,
        username: profile.username,
        phone: profile.phone,
        avatar_file: profile.avatar_file,
        is_verified: profile.is_verified,
        is_admin: profile.is_admin,
        is_banned: Boolean(user.is_banned),
        created_at: profile.created_at,
        last_login_at: user.last_login_at ?? null,
        last_online_at: user.last_seen_at ?? null,
        is_online: profile.is_online,
        verified_note: profile.verified_note,
      }
    }),
  }
}

export async function set_user_admin_role(target_id: number, is_admin: boolean): Promise<void> {
  await db.execute(
    'UPDATE users SET is_admin = ? WHERE id = ?',
    [is_admin ? 1 : 0, target_id],
  )
}

export async function set_profile_verification(target_id: number, is_verified: boolean, verified_note?: string | null): Promise<void> {
  await db.execute(
    'UPDATE users SET is_verified = ?, verified_note = ? WHERE id = ?',
    [is_verified ? 1 : 0, verified_note ?? null, target_id],
  )
}

export async function require_admin_user(event: H3Event): Promise<AuthUser> {
  const user = await require_auth_user(event)
  if (! user.is_admin) {
    throw new ApiError(403, '需要管理员权限')
  }
  return user
}
