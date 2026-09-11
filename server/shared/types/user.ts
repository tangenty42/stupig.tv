export interface User {
  id: number
  username: string
  phone: string
  avatar_file: string | null
  /** OSS ETag of the avatar object; rendered as `?version=` to bust the immutable cache. */
  avatar_version: string | null
  is_verified: boolean
  is_admin: boolean
}

export interface Profile {
  id: number
  username: string
  phone: string | null
  avatar_file: string | null
  avatar_version: string | null
  birthday: string | null
  created_at: string
  last_seen_at: string | null
  is_online: boolean
  is_verified: boolean
  is_admin: boolean
  is_banned: boolean
  verified_note: string | null
  editable: boolean
}

export interface AdminUser {
  id: number
  username: string
  phone: string | null
  avatar_file: string | null
  avatar_version: string | null
  is_verified: boolean
  is_admin: boolean
  is_banned: boolean
  created_at: string
  last_login_at: string | null
  last_online_at: string | null
  is_online: boolean
  verified_note: string | null
}

export const ADMIN_FILTER_FIELDS = [
  'id',
  'username',
  'phone',
  'is_verified',
  'is_admin',
  'is_banned',
  'created_at',
] as const satisfies readonly (keyof AdminUser)[]

export interface AdminUserList {
  total: number
  users: AdminUser[]
}
