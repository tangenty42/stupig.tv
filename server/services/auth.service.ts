import type { DeviceContext } from '@server/services/session.service'
import type { AuthLoginWithPasswordInput, AuthLoginWithPhoneInput, AuthOtpCooldownInput, AuthRegisterInput, AuthSendOtpInput, AuthUser } from '@server/types/auth'
import type { H3Event } from 'h3'
import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise'

import { runtime_config } from '@config/loader'
import { ApiError } from '@server/errors/ApiError'
import { verify_captcha } from '@server/lib/captcha'
import { db } from '@server/lib/db'
import { error_fields, log_error } from '@server/lib/log'
import { clear_auth_token_cookie, make_token_hash, set_auth_token_cookie, sign_auth_token } from '@server/lib/session'
import { check_otp_sms, send_otp_sms } from '@server/lib/sms'
import { publish_refresh, sync_resource } from '@server/lib/sync'
import { otp_cooldown_channels } from '@server/lib/sync-channel'
import { require_auth_user } from '@server/services/auth-guards.service'
import { create_login_session, logout_session } from '@server/services/session.service'
import { normalize_permission_grants } from '@shared/permissions'
import { phone_schema } from '@shared/schemas'
import bcrypt from 'bcryptjs'
import dayjs from 'dayjs'
import utc from 'dayjs/plugin/utc.js'

const config = runtime_config()

dayjs.extend(utc)

interface UserIdRow extends RowDataPacket {
  id: number
}

interface UserLoginRow extends RowDataPacket {
  id: number
  password_hash: string
  is_banned: number
}

interface UserAuthRow extends RowDataPacket {
  id: number
  username: string
  phone: string
  avatar_file: string | null
  avatar_version: string | null
  is_verified: number
  is_admin: number
  permissions: unknown
}

interface OtpCooldownRecord extends RowDataPacket {
  cooldown_until: string
}

interface OtpSendCountRow extends RowDataPacket {
  send_count: number
  cooling_down: number | null
}

interface CaptchaInput {
  lot_number?: string
  captcha_output?: string
  pass_token?: string
  gen_time?: string
}

interface SendOtpRequest extends CaptchaInput {
  phone?: string
  purpose: AuthSendOtpInput['purpose']
}

export async function register_user(event: H3Event, payload: AuthRegisterInput, device: DeviceContext, identity_token: string) {
  await check_otp_sms({ phone: payload.phone, code: payload.otp })

  const [existing] = await db.execute<UserIdRow[]>(
    'SELECT id FROM users WHERE username = ? OR phone = ? LIMIT 1',
    [payload.username, payload.phone],
  )
  if (existing.length > 0) {
    throw new ApiError(409, '用户名或手机号已存在')
  }

  const password_hash = await bcrypt.hash(payload.password, config.app.auth.bcryptRounds)

  const [result] = await db.execute<ResultSetHeader>(
    'INSERT INTO users (username, phone, password_hash) VALUES (?, ?, ?)',
    [payload.username, payload.phone, password_hash],
  )
  const user_id = Number(result.insertId)

  return build_auth_result(event, user_id, device, identity_token)
}

export async function login_with_password(event: H3Event, payload: AuthLoginWithPasswordInput & CaptchaInput, device: DeviceContext, identity_token: string) {
  await verify_captcha(payload)

  const [rows] = await db.execute<UserLoginRow[]>(
    'SELECT id, password_hash, is_banned FROM users WHERE username = ? OR phone = ? LIMIT 1',
    [payload.username_or_phone, payload.username_or_phone],
  )
  const user = rows[0]
  if (! user) {
    throw new ApiError(401, '用户名或密码错误')
  }

  if (user.is_banned) {
    throw new ApiError(401, '账号已被禁用')
  }

  const valid = await bcrypt.compare(payload.password, user.password_hash)
  if (! valid) {
    throw new ApiError(401, '用户名或密码错误')
  }

  return build_auth_result(event, user.id, device, identity_token)
}

export async function login_with_phone(event: H3Event, payload: AuthLoginWithPhoneInput, device: DeviceContext, identity_token: string) {
  await check_otp_sms({ phone: payload.phone, code: payload.otp })

  const [rows] = await db.execute<UserLoginRow[]>(
    'SELECT id, is_banned FROM users WHERE phone = ? LIMIT 1',
    [payload.phone],
  )
  const user = rows[0]
  if (! user) {
    throw new ApiError(401, '手机号未注册')
  }

  if (user.is_banned) {
    throw new ApiError(401, '账号已被禁用')
  }

  return build_auth_result(event, user.id, device, identity_token)
}

// The token is delivered as an httpOnly cookie and deliberately not returned:
// keeping it out of the response body is what makes the httpOnly attribute
// meaningful, since a body copy would be readable by any script on the page.
async function build_auth_result(event: H3Event, user_id: number, device: DeviceContext, identity_token: string) {
  const { token, exp } = sign_auth_token(user_id)
  await create_login_session(user_id, { hash: await make_token_hash(token), exp }, identity_token, device)

  // A new device came online; refresh session lists on all clients.
  publish_refresh({ resource: sync_resource('profile_sessions', user_id) })

  const [rows] = await db.execute<UserAuthRow[]>(
    'SELECT id, username, phone, avatar_file, avatar_version, is_verified, is_admin, permissions FROM users WHERE id = ?',
    [user_id],
  )
  const user = rows[0]
  if (! user) {
    throw new ApiError(500, '无法获取用户信息')
  }

  set_auth_token_cookie(event, token)

  return {
    user: {
      id: user.id,
      username: user.username,
      phone: user.phone,
      avatar_file: user.avatar_file,
      avatar_version: user.avatar_version,
      is_verified: Boolean(user.is_verified),
      is_admin: Boolean(user.is_admin),
      permissions: normalize_permission_grants(user.permissions),
    },
  }
}

export async function get_otp_cooldown(input: AuthOtpCooldownInput) {
  const now = dayjs.utc()
  const where_clause = input.phone
    ? '(identity_token = ? OR phone = ?)'
    : 'identity_token = ?'
  const params = input.phone
    ? [input.identity_token, input.phone]
    : [input.identity_token]

  const [rows] = await db.execute<OtpCooldownRecord[]>(
    `SELECT cooldown_until FROM otp_send_logs WHERE ${where_clause} ORDER BY cooldown_until DESC LIMIT 1`,
    params,
  )
  const record = rows[0]

  const cooldown_until = record ? dayjs.utc(record.cooldown_until) : null
  // The channel strings are the only way a browser can name these resources:
  // they are keyed server-side and re-issued on every query, so the client
  // follows a key rotation on its next fetch.
  const channels = otp_cooldown_channels(input.phone, input.identity_token)

  if (! cooldown_until || cooldown_until.diff(now) <= 0) {
    return { can_send: true, next_available_at: null, channels }
  }

  return { can_send: false, next_available_at: record!.cooldown_until, channels }
}

function calc_otp_send_tier(sent_count: number) {
  if (sent_count < config.app.otp.tier1.dailyLimit) {
    return 1
  }
  else if (sent_count < config.app.otp.tier1.dailyLimit + config.app.otp.tier2.dailyLimit) {
    return 2
  }
  else {
    return 0
  }
}

async function reserve_otp_send(payload: AuthSendOtpInput, identity_token: string) {
  const connection = await db.getConnection()
  let reusable = false
  try {
    // One database-scoped lock covers both overlapping identity/phone quotas,
    // including first use with no rows to lock. Never hold it during SMS I/O.
    // Fail fast under contention instead of filling the connection pool.
    const [locks] = await connection.execute<RowDataPacket[]>(
      'SELECT GET_LOCK(CONCAT(\'stupig:otp:\', LEFT(SHA2(DATABASE(), 256), 53)), 0) AS acquired',
    )
    reusable = locks[0]?.acquired === 0
    if (locks[0]?.acquired !== 1)
      throw new ApiError(reusable ? 429 : 503, reusable ? '验证码请求正在处理中，请稍后重试' : '验证码服务暂时不可用，请稍后重试')

    try {
      // Keep yesterday's active cooldown across UTC midnight, but count only
      // today's reservations. Use the DB clock for checks and writes alike.
      const [rows] = await connection.execute<OtpSendCountRow[]>(
        `SELECT COUNT(CASE WHEN requested_at >= UTC_DATE() THEN 1 END) AS send_count,
          MAX(cooldown_until) > UTC_TIMESTAMP() AS cooling_down
        FROM otp_send_logs WHERE (identity_token = ? OR phone = ?)
          AND (requested_at >= UTC_DATE() OR cooldown_until > UTC_TIMESTAMP())`,
        [identity_token, payload.phone],
      )
      const sent_count = Number(rows[0]?.send_count ?? 0)
      if (calc_otp_send_tier(sent_count) === 0)
        throw new ApiError(429, '已达到发送上限')
      if (rows[0]?.cooling_down)
        throw new ApiError(429, '验证码发送过于频繁，请稍后重试')

      const cooldown_ms = calc_otp_send_tier(sent_count - 1) === 1 ? config.app.otp.tier1.cooldownMs : config.app.otp.tier2.cooldownMs
      await connection.execute(
        `INSERT INTO otp_send_logs (identity_token, phone, purpose, requested_at, cooldown_until)
        VALUES (?, ?, ?, UTC_TIMESTAMP(), CASE WHEN ? THEN TIMESTAMPADD(DAY, 1, UTC_DATE())
          ELSE TIMESTAMPADD(MICROSECOND, ?, UTC_TIMESTAMP()) END)`,
        [identity_token, payload.phone, payload.purpose, calc_otp_send_tier(sent_count + 1) === 0, cooldown_ms * 1000],
      )
    }
    finally {
      try {
        const [released] = await connection.execute<RowDataPacket[]>(
          'SELECT RELEASE_LOCK(CONCAT(\'stupig:otp:\', LEFT(SHA2(DATABASE(), 256), 53))) AS released',
        )
        reusable = released[0]?.released === 1
        if (! reusable)
          log_error('otp reservation lock release was not confirmed')
      }
      catch (error) {
        log_error('otp reservation lock release failed', error_fields(error))
      }
    }
  }
  finally {
    // A failed/ambiguous lock command must not leave a named lock on a pooled
    // session: COMMIT/ROLLBACK do not release MySQL advisory locks.
    if (reusable)
      connection.release()
    else
      connection.destroy()
  }
}

export async function send_otp(payload: AuthSendOtpInput, meta: { identity_token: string }) {
  await reserve_otp_send(payload, meta.identity_token)
  // Notify only after a reservation exists, including when SMS later fails.
  // Rejected requests must not cause cross-tab refresh traffic.
  publish_refresh({ resource: sync_resource('otp_cooldown', payload.phone) })
  publish_refresh({ resource: sync_resource('otp_cooldown_by_identity', meta.identity_token) })
  // Once reserved, even a timeout/provider error consumes quota: delivery may
  // have happened remotely. Never remove the reservation and allow a resend.
  await send_otp_sms({ phone: payload.phone, out_id: crypto.randomUUID() })
}

export async function logout_user(event: H3Event, auth_user: AuthUser) {
  await logout_session(auth_user.session_id)
  // The client cannot clear an httpOnly cookie itself, so the server must.
  clear_auth_token_cookie(event)
  publish_refresh({ resource: sync_resource('profile_sessions', auth_user.id) })
  publish_refresh({ resource: sync_resource('auth_user', auth_user.id) })
}

export async function send_otp_for_request(event: H3Event, input: SendOtpRequest, identity_token: string) {
  await verify_captcha(input)

  const needs_auth = input.purpose === 'change_password' || input.purpose === 'verify_old_phone'
  const phone = needs_auth
    ? (await require_auth_user(event)).phone
    : input.phone
  const payload = { phone: phone_schema.parse(phone), purpose: input.purpose }

  await send_otp(payload, { identity_token })
}
