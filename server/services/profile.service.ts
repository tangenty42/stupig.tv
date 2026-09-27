import type { AuthUser } from '@server/types/auth'
import type { RowDataPacket } from 'mysql2/promise'
import { extname } from 'node:path'
import { ApiError } from '@server/errors/ApiError'

import { verify_captcha } from '@server/lib/captcha'
import { db } from '@server/lib/db'
import { check_otp_sms } from '@server/lib/sms'
import { delete_object, put_object } from '@server/lib/storage'
import { publish_refresh, sync_resource } from '@server/lib/sync'
import { logout_session } from '@server/services/session.service'
import { env } from '@shared/env'
import { has_permission, normalize_permission_grants } from '@shared/permissions'
import bcrypt from 'bcryptjs'
import dayjs from 'dayjs'
import utc from 'dayjs/plugin/utc'

dayjs.extend(utc)

export interface UserRow extends RowDataPacket {
  id: number
  username: string
  phone: string
  avatar_file: string | null
  avatar_version: string | null
  birthday: string | null
  created_at: string
  last_login_at: string | null
  last_seen_at: string | null
  is_online: number
  is_verified: number
  is_admin: number
  verified_note: string | null
  is_banned: number
  permissions: unknown
}

interface PasswordHashRow extends RowDataPacket {
  password_hash: string
}

interface UserIdRow extends RowDataPacket {
  id: number
}

interface UserAvatarRow extends RowDataPacket {
  avatar_file: string | null
  avatar_version: string | null
}

interface SessionUserIdRow extends RowDataPacket {
  user_id: number
}

interface CaptchaInput {
  lot_number?: string
  captcha_output?: string
  pass_token?: string
  gen_time?: string
}

interface AvatarUploadOptions {
  max_size_mb: number
}

const mime_to_ext: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
}
const allowed_avatar_ext = new Set(['.jpg', '.jpeg', '.png', '.webp'])

function publish_profile_refresh(id: number) {
  publish_refresh({ resource: sync_resource('profile', id) })
  publish_refresh({ resource: sync_resource('auth_user', id) })
}

export function is_profile_editable(viewer: AuthUser | null, target_id: number) {
  return has_permission(viewer, 'admin_access', 'full') || viewer?.id === target_id
}

export function format_profile_row(viewer: AuthUser | null, user: UserRow, target_id: number) {
  const editable = is_profile_editable(viewer, target_id)

  return {
    id: user.id,
    username: user.username,
    phone: editable ? user.phone : null,
    avatar_file: user.avatar_file,
    avatar_version: user.avatar_version,
    birthday: user.birthday,
    created_at: user.created_at,
    last_seen_at: user.last_seen_at ?? null,
    is_online: Boolean(user.is_online),
    is_verified: Boolean(user.is_verified),
    is_admin: Boolean(user.is_admin),
    is_banned: Boolean(user.is_banned),
    verified_note: user.verified_note,
    // 权限列表对所有人公开；is_admin 用户的列表恒为空，等价于全部权限
    permissions: normalize_permission_grants(user.permissions),
    editable,
  }
}

export const select_profile_row_sql = `
  SELECT
    u.id, u.username, u.phone, u.avatar_file, u.avatar_version, u.birthday, u.created_at,
    u.is_verified, u.is_admin, u.verified_note, u.is_banned, u.permissions,
    (SELECT MAX(s.login_at) FROM user_login_sessions s WHERE s.user_id = u.id) AS last_login_at,
    (SELECT MAX(s.last_seen_at) FROM user_login_sessions s WHERE s.user_id = u.id) AS last_seen_at,
    EXISTS(
      SELECT 1 FROM user_login_sessions s
      WHERE s.user_id = u.id AND s.is_logged_out = 0 AND s.expires_at > NOW() AND s.last_seen_at >= NOW() - INTERVAL ? SECOND
    ) AS is_online
  FROM users u
`

export async function get_profile(viewer: AuthUser | null, target_id: number) {
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

interface SitemapUserRow extends RowDataPacket {
  id: number
}

export async function list_sitemap_user_ids() {
  const [rows] = await db.execute<SitemapUserRow[]>(
    'SELECT id FROM users WHERE is_banned = 0 ORDER BY id',
  )
  return rows.map(row => row.id)
}

export async function update_profile(user_id: number, payload: { birthday: string | null }) {
  await db.execute(
    'UPDATE users SET birthday = ? WHERE id = ?',
    [payload.birthday ? dayjs.utc(payload.birthday).toDate() : null, user_id],
  )
  publish_profile_refresh(user_id)
}

interface ChangePasswordInput extends CaptchaInput {
  old_password: string
  new_password: string
  confirm_new_password: string
}

export async function change_profile_password(user_id: number, payload: ChangePasswordInput) {
  await verify_captcha(payload)

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
  publish_refresh({ resource: sync_resource('auth_user', user_id) })
}

interface ChangePasswordByOtpInput extends CaptchaInput {
  otp: string
  new_password: string
  confirm_new_password: string
}

export async function change_profile_password_by_otp(auth_user: AuthUser, payload: ChangePasswordByOtpInput) {
  await verify_captcha(payload)
  await check_otp_sms({ phone: auth_user.phone, code: payload.otp })

  if (payload.new_password !== payload.confirm_new_password) {
    throw new ApiError(400, '两次输入的密码不一致')
  }

  await reset_profile_password(auth_user.id, payload.new_password)
}

export async function reset_profile_password(user_id: number, new_password: string) {
  const new_hash = await bcrypt.hash(new_password, env.BCRYPT_ROUNDS)
  await db.execute(
    'UPDATE users SET password_hash = ? WHERE id = ?',
    [new_hash, user_id],
  )
  publish_refresh({ resource: sync_resource('auth_user', user_id) })
}

interface ChangePhoneInput extends CaptchaInput {
  new_phone: string
  old_otp: string
  new_otp: string
}

export async function change_profile_phone(auth_user: AuthUser, payload: ChangePhoneInput) {
  await verify_captcha(payload)
  if (! auth_user.phone) {
    throw new ApiError(400, '当前账号未绑定手机号，无法验证原手机号')
  }
  await check_otp_sms({ phone: auth_user.phone, code: payload.old_otp })
  await check_otp_sms({ phone: payload.new_phone, code: payload.new_otp })
  await set_profile_phone(auth_user.id, payload.new_phone)
}

export async function set_profile_phone(user_id: number, new_phone: string) {
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
  publish_profile_refresh(user_id)
}

async function update_profile_avatar(user_id: number, avatar_file: string, avatar_version: string | null) {
  const [rows] = await db.execute<UserAvatarRow[]>(
    'SELECT avatar_file FROM users WHERE id = ?',
    [user_id],
  )
  const previous_file = rows[0]?.avatar_file ?? null

  await db.execute(
    'UPDATE users SET avatar_file = ?, avatar_version = ? WHERE id = ?',
    [avatar_file, avatar_version, user_id],
  )

  return { previous_file }
}

export async function delete_profile_avatar(user_id: number) {
  const [rows] = await db.execute<UserAvatarRow[]>(
    'SELECT avatar_file FROM users WHERE id = ?',
    [user_id],
  )
  const previous_file = rows[0]?.avatar_file ?? null

  if (! previous_file) {
    throw new ApiError(400, '当前没有设置头像')
  }

  await db.execute(
    'UPDATE users SET avatar_file = NULL, avatar_version = NULL WHERE id = ?',
    [user_id],
  )

  await delete_object(`avatar/${previous_file}`).catch(() => {})
  publish_profile_refresh(user_id)
}

export async function force_logout_session(user_id: number, session_id: number) {
  const [rows] = await db.execute<SessionUserIdRow[]>(
    'SELECT user_id FROM user_login_sessions WHERE id = ?',
    [session_id],
  )
  const session = rows[0]
  if (! session || session.user_id !== user_id) {
    throw new ApiError(403, '无权限操作该会话')
  }

  await logout_session(session_id)
  publish_refresh({ resource: sync_resource('auth_user', user_id) })
  publish_refresh({ resource: sync_resource('profile', user_id) })
  publish_refresh({ resource: sync_resource('profile_sessions', user_id) })
}

export async function upload_profile_avatar(user_id: number, input: FormData, get_options: () => AvatarUploadOptions) {
  const avatar = input.get('avatar')
  if (! (avatar instanceof Blob) || avatar.size === 0) {
    throw new ApiError(400, '请先选择头像文件')
  }

  const file_data = Buffer.from(await avatar.arrayBuffer())
  const options = get_options()
  if (file_data.length > options.max_size_mb * 1024 * 1024) {
    throw new ApiError(413, `头像文件太大了，不能超过 ${options.max_size_mb} MB`)
  }

  const file_name = 'name' in avatar && typeof avatar.name === 'string' ? avatar.name : ''
  const ext_from_name = extname(file_name).toLowerCase()
  const file_ext = mime_to_ext[avatar.type]
    || (allowed_avatar_ext.has(ext_from_name) ? (ext_from_name === '.jpeg' ? '.jpg' : ext_from_name) : '')
  if (! file_ext) {
    throw new ApiError(415, '只支持 JPG / PNG / WebP')
  }

  // Fixed object key per user; the stored ETag becomes the URL `?version=`
  // cache-buster, replacing the random token previously baked into the name.
  const avatar_file_name = `${user_id}${file_ext}`
  // Put before the DB update so the (shared-key) object exists before its URL does.
  const etag = await put_object(`avatar/${avatar_file_name}`, file_data, avatar.type || null)
  const { previous_file } = await update_profile_avatar(user_id, avatar_file_name, etag)
  if (previous_file && previous_file !== avatar_file_name) {
    await delete_object(`avatar/${previous_file}`).catch(() => {})
  }
  publish_profile_refresh(user_id)
}
