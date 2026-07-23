import type { AuthUser } from '@server/types/auth'
import type { Profile } from '@shared/types/api'
import type { RowDataPacket } from 'mysql2/promise'
import { ApiError } from '@server/errors/ApiError'

import { db } from '@server/lib/db'
import { logout_session } from '@server/services/session.service'
import { env } from '@shared/env'
import bcrypt from 'bcryptjs'
import dayjs from 'dayjs'
import utc from 'dayjs/plugin/utc'

dayjs.extend(utc)

export interface UserRow extends RowDataPacket {
  id: number
  username: string
  phone: string
  avatar_file: string | null
  birthday: string | null
  created_at: string
  last_login_at: string | null
  last_seen_at: string | null
  is_online: number
  is_verified: number
  is_admin: number
  verified_note: string | null
  is_banned: number
}

interface PasswordHashRow extends RowDataPacket {
  password_hash: string
}

interface UserIdRow extends RowDataPacket {
  id: number
}

interface UserAvatarRow extends RowDataPacket {
  avatar_file: string | null
}

interface SessionUserIdRow extends RowDataPacket {
  user_id: number
}

export function is_profile_editable(viewer: AuthUser | null, target_id: number): boolean {
  return Boolean(viewer?.is_admin) || viewer?.id === target_id
}

export function format_profile_row(viewer: AuthUser | null, user: UserRow, target_id: number): Profile {
  const editable = is_profile_editable(viewer, target_id)

  return {
    id: user.id,
    username: user.username,
    phone: editable ? user.phone : null,
    avatar_file: user.avatar_file,
    birthday: user.birthday,
    created_at: user.created_at,
    last_seen_at: user.last_seen_at ?? null,
    is_online: Boolean(user.is_online),
    is_verified: Boolean(user.is_verified),
    is_admin: Boolean(user.is_admin),
    is_banned: Boolean(user.is_banned),
    verified_note: user.verified_note,
    editable,
  }
}

export const select_profile_row_sql = `
  SELECT
    u.id, u.username, u.phone, u.avatar_file, u.birthday, u.created_at,
    u.is_verified, u.is_admin, u.verified_note, u.is_banned,
    (SELECT MAX(s.login_at) FROM user_login_sessions s WHERE s.user_id = u.id) AS last_login_at,
    (SELECT MAX(s.last_seen_at) FROM user_login_sessions s WHERE s.user_id = u.id) AS last_seen_at,
    EXISTS(
      SELECT 1 FROM user_login_sessions s
      WHERE s.user_id = u.id AND s.status = 'valid' AND s.last_seen_at >= NOW() - INTERVAL ? SECOND
    ) AS is_online
  FROM users u
`

export async function get_profile(viewer: AuthUser | null, target_id: number): Promise<Profile> {
  const [rows] = await db.execute<UserRow[]>(
    `${select_profile_row_sql} WHERE u.id = ?`,
    [env.ONLINE_TIMEOUT_SECONDS, target_id],
  )

  const user = rows[0]
  if (! user) {
    throw new ApiError(404, '用户不存在')
  }

  return format_profile_row(viewer, user, target_id)
}

export async function update_profile(user_id: number, payload: { birthday: string | null }): Promise<void> {
  await db.execute(
    'UPDATE users SET birthday = ? WHERE id = ?',
    [payload.birthday ? dayjs.utc(payload.birthday).toDate() : null, user_id],
  )
}

interface ChangePasswordInput {
  old_password: string
  new_password: string
  confirm_new_password: string
}

export async function change_profile_password(user_id: number, payload: ChangePasswordInput): Promise<void> {
  const [rows] = await db.execute<PasswordHashRow[]>(
    'SELECT password_hash FROM users WHERE id = ?',
    [user_id],
  )
  const user = rows[0]
  if (! user) {
    throw new ApiError(404, '用户不存在')
  }

  const valid = await bcrypt.compare(payload.old_password, user.password_hash)
  if (! valid) {
    throw new ApiError(400, '旧密码不正确')
  }

  const new_hash = await bcrypt.hash(payload.new_password, env.BCRYPT_ROUNDS)
  await db.execute(
    'UPDATE users SET password_hash = ? WHERE id = ?',
    [new_hash, user_id],
  )
}

interface ChangePasswordByOtpInput {
  otp: string
  new_password: string
  confirm_new_password: string
}

export async function change_profile_password_by_otp(user_id: number, payload: ChangePasswordByOtpInput): Promise<void> {
  if (payload.new_password !== payload.confirm_new_password) {
    throw new ApiError(400, '两次输入的密码不一致')
  }

  await reset_profile_password(user_id, payload.new_password)
}

export async function reset_profile_password(user_id: number, new_password: string): Promise<void> {
  const new_hash = await bcrypt.hash(new_password, env.BCRYPT_ROUNDS)
  await db.execute(
    'UPDATE users SET password_hash = ? WHERE id = ?',
    [new_hash, user_id],
  )
}

interface ChangePhoneInput {
  new_phone: string
  old_otp: string
  new_otp: string
}

export async function change_profile_phone(user_id: number, payload: ChangePhoneInput): Promise<void> {
  await set_profile_phone(user_id, payload.new_phone)
}

export async function set_profile_phone(user_id: number, new_phone: string): Promise<void> {
  const [existing] = await db.execute<UserIdRow[]>(
    'SELECT id FROM users WHERE phone = ? AND id != ? LIMIT 1',
    [new_phone, user_id],
  )
  if (existing.length > 0) {
    throw new ApiError(409, '新手机号已被使用')
  }

  await db.execute(
    'UPDATE users SET phone = ? WHERE id = ?',
    [new_phone, user_id],
  )
}

export async function update_profile_avatar(user_id: number, avatar_file: string): Promise<{ previous_file: string | null }> {
  const [rows] = await db.execute<UserAvatarRow[]>(
    'SELECT avatar_file FROM users WHERE id = ?',
    [user_id],
  )
  const previous_file = rows[0]?.avatar_file ?? null

  await db.execute(
    'UPDATE users SET avatar_file = ? WHERE id = ?',
    [avatar_file, user_id],
  )

  return { previous_file }
}

export async function delete_profile_avatar(user_id: number): Promise<{ previous_file: string | null }> {
  const [rows] = await db.execute<UserAvatarRow[]>(
    'SELECT avatar_file FROM users WHERE id = ?',
    [user_id],
  )
  const previous_file = rows[0]?.avatar_file ?? null

  if (! previous_file) {
    throw new ApiError(400, '当前没有设置头像')
  }

  await db.execute(
    'UPDATE users SET avatar_file = NULL WHERE id = ?',
    [user_id],
  )

  return { previous_file }
}

export async function force_logout_session(user_id: number, session_id: number): Promise<void> {
  const [rows] = await db.execute<SessionUserIdRow[]>(
    'SELECT user_id FROM user_login_sessions WHERE id = ?',
    [session_id],
  )
  const session = rows[0]
  if (! session || session.user_id !== user_id) {
    throw new ApiError(403, '无权限操作该会话')
  }

  await logout_session(session_id)
}
