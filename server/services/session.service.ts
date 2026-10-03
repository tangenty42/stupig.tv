import type { H3Event } from 'h3'
import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise'

import { db } from '@server/lib/db'
import { get_client_ip } from '@server/lib/session'
import { runtime_config } from '@shared/config'
import dayjs from 'dayjs'
import utc from 'dayjs/plugin/utc.js'

const config = runtime_config()

dayjs.extend(utc)

export interface DeviceContext {
  login_ip: string | null
  last_seen_ip: string | null
  user_agent: string | null
}

interface SessionRow extends RowDataPacket {
  id: number
  user_id: number
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

export function get_request_device_context(event: H3Event) {
  const user_agent = getHeader(event, 'user-agent') ?? null
  const ip = get_client_ip(event)

  return {
    login_ip: ip,
    last_seen_ip: ip,
    user_agent,
  }
}

// Every generation the browser might still hold stays valid in
// user_login_session_tokens (see the migration); `first_token` is the generation
// being issued right now.
export async function create_login_session(
  user_id: number,
  first_token: { hash: string, exp: number },
  identity_token: string,
  device: DeviceContext,
) {
  const expires_at = dayjs().utc().add(config.app.auth.session.maxAgeDays, 'day')
    .toDate()

  const connection = await db.getConnection()
  try {
    await connection.beginTransaction()

    // Reuse the latest inactive row for this device by reviving it. Active rows
    // (not logged out, unexpired) are left alone so concurrent active
    // tabs/devices keep their own rows.
    const [existing] = await connection.execute<ReusableSessionRow[]>(
      `SELECT id, (is_logged_out = 1 OR expires_at <= NOW()) AS is_reusable
       FROM user_login_sessions
       WHERE user_id = ? AND identity_token = ?
       ORDER BY id DESC LIMIT 1`,
      [user_id, identity_token],
    )
    const reusable = existing[0]

    let session_id: number

    if (reusable && reusable.is_reusable) {
      await connection.execute(
        `UPDATE user_login_sessions SET
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
          expires_at,
          device.login_ip,
          device.last_seen_ip,
          device.user_agent,
          reusable.id,
        ],
      )
      session_id = reusable.id

      // Logging in again revokes every generation this device held before.
      await connection.execute(
        'DELETE FROM user_login_session_tokens WHERE session_id = ?',
        [session_id],
      )
    }
    else {
      const [inserted] = await connection.execute<ResultSetHeader>(
        `INSERT INTO user_login_sessions
           (user_id, identity_token, is_logged_out, login_at, last_seen_at, logout_at, expires_at, login_ip, last_seen_ip, user_agent)
         VALUES (?, ?, 0, NOW(), NOW(), NULL, ?, ?, ?, ?)`,
        [
          user_id,
          identity_token,
          expires_at,
          device.login_ip,
          device.last_seen_ip,
          device.user_agent,
        ],
      )
      session_id = inserted.insertId
    }

    await connection.execute(
      'INSERT INTO user_login_session_tokens (session_id, token_hash, expires_at) VALUES (?, ?, ?)',
      [session_id, first_token.hash, dayjs.utc(first_token.exp * 1000).toDate()],
    )

    await connection.commit()
  }
  catch (error) {
    await connection.rollback()
    throw error
  }
  finally {
    connection.release()
  }
}

// Slides the session's idle expiry and, when `next` is given, appends a new
// token generation.
//
// Appending is guarded by "nothing newer than the generation this request
// presented exists": a browser stuck on an old cookie would otherwise append a
// generation on every request, and concurrent retries would multiply those rows.
// The guard lives on the family table because the session row no longer holds a
// token hash to compare against; a generation that loses the race is simply not
// written, and the browser keeps the new generation it was handed.
//
// Rotating does not invalidate older generations: they live in
// user_login_session_tokens until their own JWT expires, which is what keeps an
// in-flight request (or one whose Set-Cookie never arrived) from being 401'd.
export async function refresh_login_session(params: {
  session_id: number
  presented_generation_id: number
  next: { hash: string, exp: number } | null
  last_seen_ip: string | null
}) {
  const { session_id, presented_generation_id, next, last_seen_ip } = params
  const connection = await db.getConnection()

  try {
    await connection.beginTransaction()

    await connection.execute(
      `UPDATE user_login_sessions
       SET last_seen_at = NOW(),
           last_seen_ip = ?,
           expires_at = NOW() + INTERVAL ? DAY
       WHERE id = ?`,
      [
        last_seen_ip,
        config.app.auth.session.maxAgeDays,
        session_id,
      ],
    )

    let applied = false

    if (next) {
      const [inserted] = await connection.execute<ResultSetHeader>(
        `INSERT INTO user_login_session_tokens (session_id, token_hash, expires_at)
         SELECT ?, ?, ? FROM DUAL
         WHERE NOT EXISTS (
           SELECT 1 FROM user_login_session_tokens WHERE session_id = ? AND id > ?
         )`,
        [
          session_id,
          next.hash,
          dayjs.utc(next.exp * 1000).toDate(),
          session_id,
          presented_generation_id,
        ],
      )
      applied = inserted.affectedRows === 1
    }

    // Drop generations that can no longer authenticate (they expire with their
    // JWT), then trim to the newest SESSION_MAX_TOKEN_GENERATIONS. The trim is
    // what bounds the family: a client whose cookie never updates is re-issued a
    // generation on every request, otherwise growing the table without limit.
    //
    // The limit is inlined because MySQL rejects a placeholder there in prepared
    // statements (ER_WRONG_ARGUMENTS); it is a validated config integer, never
    // user input.
    const keep_generations = Math.max(1, Math.trunc(config.app.auth.session.maxTokenGenerations))
    await connection.execute(
      `DELETE FROM user_login_session_tokens
       WHERE session_id = ?
         AND (
           expires_at <= NOW()
           OR id NOT IN (
             SELECT id FROM (
               SELECT id FROM user_login_session_tokens
               WHERE session_id = ?
               ORDER BY id DESC
               LIMIT ${keep_generations}
             ) AS newest
           )
         )`,
      [session_id, session_id],
    )

    await connection.commit()
    return applied
  }
  catch (error) {
    await connection.rollback()
    throw error
  }
  finally {
    connection.release()
  }
}

export async function get_login_sessions(
  user_id: number,
  current_session_id: number | null,
) {
  const [rows] = await db.execute<SessionRow[]>(
    `SELECT
       id,
       user_id,
       identity_token,
       is_logged_out,
       (expires_at <= NOW()) AS is_expired,
       (is_logged_out = 0 AND expires_at > NOW() AND last_seen_at >= NOW() - INTERVAL ? SECOND) AS is_online,
       (id <=> ?) AS is_current,
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
    [config.app.online.timeoutSeconds, current_session_id, user_id, config.app.online.timeoutSeconds],
  )

  const records = rows.map(row => ({
    ... row,
    is_logged_out: Boolean(row.is_logged_out),
    is_expired: Boolean(row.is_expired),
    is_online: Boolean(row.is_online),
    is_current: Boolean(row.is_current),
  }))

  return { records }
}

export async function logout_session(id: number) {
  await db.execute(
    'UPDATE user_login_sessions SET is_logged_out = 1, logout_at = NOW() WHERE id = ?',
    [id],
  )
}

export async function logout_all_user_sessions(user_id: number) {
  await db.execute(
    'UPDATE user_login_sessions SET is_logged_out = 1, logout_at = NOW() WHERE user_id = ?',
    [user_id],
  )
}
