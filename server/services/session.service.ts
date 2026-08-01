import type { SessionOverview } from '@shared/types/api'
import type { H3Event } from 'h3'
import type { RowDataPacket } from 'mysql2/promise'

import { db } from '@server/lib/db'
import { get_client_ip } from '@server/lib/session'
import { env } from '@shared/env'
import dayjs from 'dayjs'
import utc from 'dayjs/plugin/utc'

dayjs.extend(utc)

export interface DeviceContext {
  login_ip: string | null
  last_seen_ip: string | null
  user_agent: string | null
}

interface SessionRow extends RowDataPacket {
  id: number
  user_id: number
  token_hash: string
  identity_token: string | null
  is_logged_out: number
  is_expired: number
  is_online: number
  is_current: number
  login_at: string
  last_seen_at: string
  logout_at: string | null
  expires_at: string
  login_ip: string | null
  last_seen_ip: string | null
  user_agent: string | null
}

interface ReusableSessionRow extends RowDataPacket {
  id: number
  is_reusable: number
}

export function get_request_device_context(event: H3Event): DeviceContext {
  const user_agent = getHeader(event, 'user-agent') ?? null
  const ip = get_client_ip(event)

  return {
    login_ip: ip,
    last_seen_ip: ip,
    user_agent,
  }
}

export async function create_login_session(
  user_id: number,
  token_hash: string,
  identity_token: string,
  device: DeviceContext,
): Promise<void> {
  const expires_at = dayjs().utc().add(env.SESSION_MAX_AGE_DAYS, 'day')
    .toDate()

  // Reuse the latest inactive row for this device by rotating its token_hash.
  // Active rows (not logged out, unexpired) are left alone so concurrent
  // active tabs/devices keep their own rows.
  const [existing] = await db.execute<ReusableSessionRow[]>(
    `SELECT id, (is_logged_out = 1 OR expires_at <= NOW()) AS is_reusable
     FROM user_login_sessions
     WHERE user_id = ? AND identity_token = ?
     ORDER BY id DESC LIMIT 1`,
    [user_id, identity_token],
  )
  const reusable = existing[0]

  if (reusable && reusable.is_reusable) {
    await db.execute(
      `UPDATE user_login_sessions SET
         token_hash = ?,
         is_logged_out = 0,
         login_at = NOW(),
         last_seen_at = NOW(),
         logout_at = NULL,
         expires_at = ?,
         login_ip = ?,
         last_seen_ip = ?,
         user_agent = ?
       WHERE id = ?`,
      [
        token_hash,
        expires_at,
        device.login_ip,
        device.last_seen_ip,
        device.user_agent,
        reusable.id,
      ],
    )
    return
  }

  await db.execute(
    `INSERT INTO user_login_sessions
       (user_id, token_hash, identity_token, is_logged_out, login_at, last_seen_at, logout_at, expires_at, login_ip, last_seen_ip, user_agent)
     VALUES (?, ?, ?, 0, NOW(), NOW(), NULL, ?, ?, ?, ?)`,
    [
      user_id,
      token_hash,
      identity_token,
      expires_at,
      device.login_ip,
      device.last_seen_ip,
      device.user_agent,
    ],
  )
}

export async function get_login_sessions(
  user_id: number,
  current_token_hash: string | null,
): Promise<SessionOverview> {
  const [rows] = await db.execute<SessionRow[]>(
    `SELECT
       id,
       user_id,
       token_hash,
       identity_token,
       is_logged_out,
       (expires_at <= NOW()) AS is_expired,
       (is_logged_out = 0 AND expires_at > NOW() AND last_seen_at >= NOW() - INTERVAL ? SECOND) AS is_online,
       (token_hash <=> ?) AS is_current,
       login_at,
       last_seen_at,
       logout_at,
       expires_at,
       login_ip,
       last_seen_ip,
       user_agent
     FROM user_login_sessions
     WHERE user_id = ?
     ORDER BY
       is_current DESC,
       CASE
         WHEN is_logged_out = 0 AND expires_at > NOW() AND last_seen_at >= NOW() - INTERVAL ? SECOND THEN 0
         WHEN is_logged_out = 0 AND expires_at > NOW() THEN 1
         ELSE 2
       END ASC,
       id DESC`,
    [env.ONLINE_TIMEOUT_SECONDS, current_token_hash, user_id, env.ONLINE_TIMEOUT_SECONDS],
  )

  const records = rows.map(row => ({
    ...row,
    is_logged_out: Boolean(row.is_logged_out),
    is_expired: Boolean(row.is_expired),
    is_online: Boolean(row.is_online),
    is_current: Boolean(row.is_current),
  }))

  return { records }
}

export async function logout_session(id: number): Promise<void> {
  await db.execute(
    'UPDATE user_login_sessions SET is_logged_out = 1, logout_at = NOW() WHERE id = ?',
    [id],
  )
}

export async function logout_session_by_token_hash(token_hash: string): Promise<void> {
  await db.execute(
    'UPDATE user_login_sessions SET is_logged_out = 1, logout_at = NOW() WHERE token_hash = ?',
    [token_hash],
  )
}

export async function logout_all_user_sessions(user_id: number, except_token_hash?: string | null): Promise<void> {
  if (except_token_hash) {
    await db.execute(
      'UPDATE user_login_sessions SET is_logged_out = 1, logout_at = NOW() WHERE user_id = ? AND token_hash != ?',
      [user_id, except_token_hash],
    )
  }
  else {
    await db.execute(
      'UPDATE user_login_sessions SET is_logged_out = 1, logout_at = NOW() WHERE user_id = ?',
      [user_id],
    )
  }
}
