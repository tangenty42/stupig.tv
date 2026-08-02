import type { DeviceContext } from '@server/services/session.service'
import type { AuthLoginWithPasswordInput, AuthLoginWithPhoneInput, AuthOtpCooldownInput, AuthRegisterInput, AuthSendOtpInput, AuthUser } from '@server/types/auth'
import type { H3Event } from 'h3'
import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise'

import { ApiError } from '@server/errors/ApiError'
import { verify_captcha } from '@server/lib/captcha'
import { db } from '@server/lib/db'
import { make_token_hash, sign_auth_token } from '@server/lib/session'
import { check_otp_sms, send_otp_sms } from '@server/lib/sms'
import { publish_refresh, sync_resource } from '@server/lib/sync'
import { require_auth_user } from '@server/services/auth-guards.service'
import { create_login_session, logout_session_by_token_hash } from '@server/services/session.service'
import { env } from '@shared/env'
import { phone_schema } from '@shared/schemas'
import bcrypt from 'bcryptjs'
import dayjs from 'dayjs'
import utc from 'dayjs/plugin/utc'

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
  is_verified: number
  is_admin: number
}

interface OtpCooldownRecord extends RowDataPacket {
  cooldown_until: string
}

interface OtpSendCountRow extends RowDataPacket {
  send_count: number
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

export async function register_user(payload: AuthRegisterInput, device: DeviceContext, identity_token: string) {
  await check_otp_sms({ phone: payload.phone, code: payload.otp })

  const [existing] = await db.execute<UserIdRow[]>(
    'SELECT id FROM users WHERE username = ? OR phone = ? LIMIT 1',
    [payload.username, payload.phone],
  )
  if (existing.length > 0) {
    throw new ApiError(409, '用户名或手机号已存在')
  }

  const password_hash = await bcrypt.hash(payload.password, env.BCRYPT_ROUNDS)

  const [result] = await db.execute<ResultSetHeader>(
    'INSERT INTO users (username, phone, password_hash) VALUES (?, ?, ?)',
    [payload.username, payload.phone, password_hash],
  )
  const user_id = Number(result.insertId)

  const { user, token } = await build_auth_result(user_id, device, identity_token)
  return { user, token }
}

export async function login_with_password(payload: AuthLoginWithPasswordInput & CaptchaInput, device: DeviceContext, identity_token: string) {
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

  const { user: result_user, token } = await build_auth_result(user.id, device, identity_token)
  return { user: result_user, token }
}

export async function login_with_phone(payload: AuthLoginWithPhoneInput, device: DeviceContext, identity_token: string) {
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

  const { user: result_user, token } = await build_auth_result(user.id, device, identity_token)
  return { user: result_user, token }
}

async function build_auth_result(user_id: number, device: DeviceContext, identity_token: string) {
  const jwt = sign_auth_token(user_id)
  const token_hash = await make_token_hash(jwt)
  await create_login_session(user_id, token_hash, identity_token, device)

  // A new device came online; refresh session lists on all clients.
  publish_refresh({ resource: sync_resource('profile_sessions', user_id) })

  const [rows] = await db.execute<UserAuthRow[]>(
    'SELECT id, username, phone, avatar_file, is_verified, is_admin FROM users WHERE id = ?',
    [user_id],
  )
  const user = rows[0]
  if (! user) {
    throw new ApiError(500, '无法获取用户信息')
  }

  return {
    user: {
      id: user.id,
      username: user.username,
      phone: user.phone,
      avatar_file: user.avatar_file,
      is_verified: Boolean(user.is_verified),
      is_admin: Boolean(user.is_admin),
    },
    token: jwt,
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
    `SELECT cooldown_until FROM otp_send_logs WHERE ${where_clause} ORDER BY id DESC LIMIT 1`,
    params,
  )
  const record = rows[0]

  if (! record) {
    return { can_send: true, next_available_at: null }
  }

  const cooldown_until = dayjs.utc(record.cooldown_until)
  const diff_ms = cooldown_until.diff(now)
  if (diff_ms <= 0) {
    return { can_send: true, next_available_at: null }
  }

  return { can_send: false, next_available_at: record.cooldown_until }
}

function calc_otp_send_tier(sent_count: number) {
  if (sent_count < env.OTP_TIER1_DAILY_LIMIT) {
    return 1
  }
  else if (sent_count < env.OTP_TIER1_DAILY_LIMIT + env.OTP_TIER2_DAILY_LIMIT) {
    return 2
  }
  else {
    return 0
  }
}

export async function send_otp(payload: AuthSendOtpInput, meta: { identity_token: string }) {
  const today_start = dayjs().utc()
    .startOf('day')

  const [count_rows] = await db.execute<OtpSendCountRow[]>(
    'SELECT COUNT(*) AS send_count FROM otp_send_logs WHERE (identity_token = ? OR phone = ?) AND requested_at >= ?',
    [meta.identity_token, payload.phone, today_start.toDate()],
  )
  const sent_count = count_rows[0]?.send_count ?? 0

  const tier_last = calc_otp_send_tier(sent_count - 1)
  const tier_current = calc_otp_send_tier(sent_count)
  const tier_next = calc_otp_send_tier(sent_count + 1)

  let cooldown_until: Date
  if (tier_current !== 0) {
    const cooldown_ms = tier_last === 1 ? env.OTP_TIER1_COOLDOWN_MS : env.OTP_TIER2_COOLDOWN_MS
    const out_id = `${meta.identity_token}-${Date.now()}`

    await send_otp_sms({ phone: payload.phone, out_id })

    if (tier_next !== 0) {
      cooldown_until = dayjs().utc()
        .add(cooldown_ms, 'millisecond')
        .toDate()
    }
    else {
      cooldown_until = today_start.add(1, 'day').toDate()
    }
  }
  else {
    throw new ApiError(429, '已达到发送上限')
  }

  await db.execute(
    'INSERT INTO otp_send_logs (identity_token, phone, purpose, requested_at, cooldown_until) VALUES (?, ?, ?, NOW(), ?)',
    [meta.identity_token, payload.phone, payload.purpose, cooldown_until],
  )
}

export async function logout_user(auth_user: AuthUser) {
  await logout_session_by_token_hash(auth_user.token_hash)
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
  publish_refresh({ resource: sync_resource('otp_cooldown', payload.phone) })
  publish_refresh({ resource: sync_resource('otp_cooldown_by_identity', identity_token) })
}
