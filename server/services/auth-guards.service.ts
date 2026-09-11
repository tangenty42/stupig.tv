import type { AuthUser } from '@server/types/auth'
import type { H3Event } from 'h3'
import type { RowDataPacket } from 'mysql2/promise'
import { ApiError } from '@server/errors/ApiError'

import { db } from '@server/lib/db'
import { get_auth_token_from_cookie, get_client_ip, is_auth_token_expiring, make_token_hash, set_auth_token_cookie, set_auth_user_cookie, sign_auth_token, verify_auth_token } from '@server/lib/session'
import { publish_refresh, sync_resource } from '@server/lib/sync'
import { refresh_login_session } from '@server/services/session.service'
import { env } from '@shared/env'

declare module 'h3' {
  interface H3EventContext {
    auth_user?: AuthUser
  }
}

interface SessionVerificationRecord extends RowDataPacket {
  id: number
  session_id: number
  username: string
  phone: string
  avatar_file: string | null
  avatar_version: string | null
  is_verified: number
  is_admin: number
  is_banned: number
  is_logged_out: number
  is_expired: number
  generation_id: number
  is_newest_generation: number
}

export async function require_auth_user(event: H3Event) {
  // One tRPC batch runs several procedures over a single HTTP request, so the
  // guard must resolve (and renew) at most once per request.
  const cached = event.context.auth_user
  if (cached) {
    return cached
  }

  const token = get_auth_token_from_cookie(event)
  if (! token) {
    throw new ApiError(401, '请先登录')
  }

  let payload
  try {
    payload = verify_auth_token(token)
  }
  catch {
    throw new ApiError(401, '登录状态已过期，请重新登录')
  }

  const token_hash = await make_token_hash(token)

  // Any generation of the session authenticates, not just the newest one: an
  // in-flight request, or one whose Set-Cookie never reached the browser, still
  // carries an older generation. Each generation is valid until its own JWT
  // expires, so a generation whose JWT is still valid always has a row here.
  const [rows] = await db.execute<SessionVerificationRecord[]>(
    `SELECT
       u.id,
       s.id AS session_id,
       t.id AS generation_id,
       (t.id = (SELECT MAX(t2.id) FROM user_login_session_tokens t2 WHERE t2.session_id = t.session_id)) AS is_newest_generation,
       u.username,
       u.phone,
       u.avatar_file,
       u.avatar_version,
       u.is_verified,
       u.is_admin,
       u.is_banned,
       s.is_logged_out,
       (s.expires_at <= NOW()) AS is_expired
     FROM user_login_session_tokens t
     JOIN user_login_sessions s ON s.id = t.session_id
     JOIN users u ON u.id = s.user_id
     WHERE t.token_hash = ?`,
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
  // the X-Nuxt-SSR marker set in useApi. They are not real user activity, and
  // the internal $fetch response headers never reach the browser, so a renewal
  // there would leave the DB holding a token the client does not have.
  const is_ssr_prefetch = Boolean(getRequestHeader(event, 'x-nuxt-ssr'))

  // An older generation authenticates but never rotates. The append guard in
  // refresh_login_session only admits a generation when nothing newer exists, so
  // a request on an older one would write nothing; signing a token for it would
  // be wasted work. That guard is also what bounds a client which cannot receive
  // cookies at all — it keeps presenting the same old generation, and would
  // otherwise append a fresh generation on every request.
  const is_older_generation = ! record.is_newest_generation

  if (! is_ssr_prefetch) {
    const rotate = ! is_older_generation && is_auth_token_expiring(payload.exp, env.JWT_RENEW_BEFORE_DAYS)
    const signed = rotate ? sign_auth_token(record.id) : null
    const next = signed
      ? { hash: await make_token_hash(signed.token), exp: signed.exp }
      : null

    const applied = await refresh_login_session({
      session_id: record.session_id,
      presented_generation_id: record.generation_id,
      next,
      last_seen_ip: get_client_ip(event) ?? null,
    })

    // Only the request whose generation actually landed may hand out its cookie:
    // a racer that lost the append guard wrote nothing, so its token has no row
    // and would be rejected on the next request.
    if (next && applied) {
      set_auth_token_cookie(event, signed!.token)
      // Refresh the display cookie in the same breath: it is what tells the UI
      // who is signed in, and letting it keep its original expiry would sign the
      // user out on screen while this very session stays valid.
      set_auth_user_cookie(event, {
        id: record.id,
        username: record.username,
        phone: record.phone,
        avatar_file: record.avatar_file,
        avatar_version: record.avatar_version,
        is_verified: Boolean(record.is_verified),
        is_admin: Boolean(record.is_admin),
      })
    }
  }

  const auth_user: AuthUser = {
    id: record.id,
    session_id: record.session_id,
    username: record.username,
    phone: record.phone,
    avatar_file: record.avatar_file,
    is_verified: Boolean(record.is_verified),
    is_admin: Boolean(record.is_admin),
  }

  event.context.auth_user = auth_user

  return auth_user
}

export async function require_admin_user(event: H3Event) {
  const user = await require_auth_user(event)
  if (! user.is_admin) {
    throw new ApiError(403, '需要管理员权限')
  }
  return user
}

export async function resolve_operate_target(event: H3Event, operate_for?: number | null) {
  const auth_user = await require_auth_user(event)

  if (operate_for === undefined || operate_for === null || operate_for === auth_user.id) {
    return { auth_user, target_id: auth_user.id }
  }

  if (! auth_user.is_admin) {
    throw new ApiError(403, '需要管理员权限')
  }

  return { auth_user, target_id: operate_for }
}
