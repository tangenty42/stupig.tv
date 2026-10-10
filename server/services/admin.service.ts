import type { UserRow } from '@server/services/profile.service'

import type { AuthUser } from '@server/types/auth'
import type { PermissionGrant } from '@shared/permissions'
import type { RowDataPacket } from 'mysql2/promise'
import { runtime_config } from '@config/loader'
import { ApiError } from '@server/errors/ApiError'
import { db } from '@server/lib/db'
import { publish_refresh, sync_resource } from '@server/lib/sync'
import { format_profile_row, select_profile_row_sql } from '@server/services/profile.service'
import { logout_all_user_sessions } from '@server/services/session.service'
import { normalize_permission_grants } from '@shared/permissions'

const config = runtime_config()

interface CountRow extends RowDataPacket {
  total: number
}

interface UserAdminRow extends RowDataPacket {
  is_admin: number
}

async function require_non_admin_target(target_id: number) {
  const [rows] = await db.execute<UserAdminRow[]>(
    'SELECT is_admin FROM users WHERE id = ?',
    [target_id],
  )
  if (! rows[0]) {
    throw new ApiError(404, '用户不存在')
  }
  return rows[0]
}

function publish_user_refresh(id: number) {
  publish_refresh({ resource: sync_resource('profile', id) })
  publish_refresh({ resource: sync_resource('auth_user', id) })
}

export async function force_logout_user(target_id: number) {
  await logout_all_user_sessions(target_id)
  publish_refresh({ resource: sync_resource('auth_user', target_id) })
  publish_refresh({ resource: sync_resource('profile_sessions', target_id) })
}

export async function ban_user(target_id: number) {
  await db.execute(
    'UPDATE users SET is_banned = 1 WHERE id = ?',
    [target_id],
  )
  await logout_all_user_sessions(target_id)
  publish_refresh({ resource: sync_resource('profile_sessions', target_id) })
  publish_user_refresh(target_id)
}

export async function unban_user(target_id: number) {
  await db.execute(
    'UPDATE users SET is_banned = 0 WHERE id = ?',
    [target_id],
  )
  publish_user_refresh(target_id)
}

export async function list_users(
  viewer: AuthUser,
  options: { page: number, page_size: number, filter?: string },
) {
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
    [config.app.online.timeoutSeconds, ... params, String(page_size), String(offset)],
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
        avatar_version: profile.avatar_version,
        is_verified: profile.is_verified,
        is_admin: profile.is_admin,
        is_banned: Boolean(user.is_banned),
        created_at: profile.created_at,
        last_login_at: user.last_login_at ?? null,
        last_online_at: user.last_seen_at ?? null,
        is_online: profile.is_online,
        verified_note: profile.verified_note,
        permissions: profile.permissions,
      }
    }),
  }
}

export async function set_user_admin_role(actor_id: number, target_id: number, is_admin: boolean) {
  if (! is_admin && actor_id === target_id) {
    throw new ApiError(400, '不能移除自己的管理员身份')
  }
  await require_non_admin_target(target_id)
  await db.execute(
    // 提升为管理员时清空权限列表：is_admin 等价于全部权限
    'UPDATE users SET is_admin = ?, permissions = IF(?, NULL, permissions) WHERE id = ?',
    [is_admin ? 1 : 0, is_admin ? 1 : 0, target_id],
  )
  publish_user_refresh(target_id)
}

export async function set_user_permissions(target_id: number, grants: PermissionGrant[]) {
  const target = await require_non_admin_target(target_id)
  if (target.is_admin) {
    throw new ApiError(400, '管理员拥有全部权限，无需编辑权限')
  }
  const normalized = normalize_permission_grants(grants)
  await db.execute(
    'UPDATE users SET permissions = ? WHERE id = ?',
    [normalized.length ? JSON.stringify(normalized) : null, target_id],
  )
  publish_user_refresh(target_id)
}

export async function set_profile_verification(target_id: number, is_verified: boolean, verified_note?: string | null) {
  await db.execute(
    'UPDATE users SET is_verified = ?, verified_note = ? WHERE id = ?',
    [is_verified ? 1 : 0, verified_note ?? null, target_id],
  )
  publish_user_refresh(target_id)
}
