import type { AuthUser } from '@server/types/auth'
import type { H3Event } from 'h3'
import type { RowDataPacket } from 'mysql2/promise'
import { ApiError } from '@server/errors/ApiError'

import { db } from '@server/lib/db'
import { get_auth_token_from_cookie, get_client_ip, make_token_hash, verify_auth_token } from '@server/lib/session'
import { publish_refresh, sync_resource } from '@server/lib/sync'

interface SessionVerificationRecord extends RowDataPacket {
  id: number
  username: string
  phone: string
  avatar_file: string | null
  is_verified: number
  is_admin: number
  is_banned: number
  is_logged_out: number
  is_expired: number
}

export async function require_auth_user(event: H3Event): Promise<AuthUser> {
  const token = get_auth_token_from_cookie(event)
  if (! token) {
    throw new ApiError(401, '请先登录')
  }

  try {
    verify_auth_token(token)
  }
  catch {
    throw new ApiError(401, '登录状态已过期，请重新登录')
  }

  const token_hash = await make_token_hash(token)

  const [rows] = await db.execute<SessionVerificationRecord[]>(
    `SELECT
       u.id,
       u.username,
       u.phone,
       u.avatar_file,
       u.is_verified,
       u.is_admin,
       u.is_banned,
       s.is_logged_out,
       (s.expires_at <= NOW()) AS is_expired
     FROM user_login_sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ?`,
    [token_hash],
  )

  const record = rows[0]
  if (! record) {
    throw new ApiError(401, '登录状态无效，请重新登录')
  }

  if (record.is_banned) {
    throw new ApiError(401, '账号已被禁用')
  }

  if (record.is_logged_out) {
    throw new ApiError(401, '当前会话已退出或已失效')
  }

  if (record.is_expired) {
    // This session just expired; refresh session lists on all clients.
    publish_refresh({ resource: sync_resource('profile_sessions', record.id) })
    throw new ApiError(401, '登录会话已过期')
  }

  // Requests fired by Nuxt SSR (data prefetch during server rendering) carry
  // the X-Nuxt-SSR marker set in useApi; they are not real user activity, so
  // they must not bump last_seen_at/last_seen_ip.
  if (! getRequestHeader(event, 'x-nuxt-ssr')) {
    await db.execute(
      'UPDATE user_login_sessions SET last_seen_at = NOW(), last_seen_ip = ? WHERE token_hash = ?',
      [get_client_ip(event) ?? null, token_hash],
    )
  }

  // Do not refresh session lists on every request.
  // publish_refresh({ resource: sync_resource('profile_sessions', record.id) })

  return {
    id: record.id,
    username: record.username,
    phone: record.phone,
    avatar_file: record.avatar_file,
    is_verified: Boolean(record.is_verified),
    is_admin: Boolean(record.is_admin),
    token_hash,
  }
}

export async function require_admin_user(event: H3Event): Promise<AuthUser> {
  const user = await require_auth_user(event)
  if (! user.is_admin) {
    throw new ApiError(403, '需要管理员权限')
  }
  return user
}

export async function resolve_operate_target(event: H3Event, operate_for?: number | null): Promise<{ auth_user: AuthUser, target_id: number }> {
  const auth_user = await require_auth_user(event)

  if (operate_for === undefined || operate_for === null || operate_for === auth_user.id) {
    return { auth_user, target_id: auth_user.id }
  }

  if (! auth_user.is_admin) {
    throw new ApiError(403, '需要管理员权限')
  }

  return { auth_user, target_id: operate_for }
}
