import type { PermissionGrant } from '@shared/permissions'

export interface JwtPayload {
  sub: number
  jti: string
  iat: number
  exp: number
}

export interface AuthUser {
  id: number
  session_id: number
  /** Immutable token row; a revived device session must not revive old reads. */
  token_generation_id?: number
  username: string
  phone: string
  avatar_file: string | null
  is_verified: boolean
  is_admin: boolean
  permissions?: PermissionGrant[]
}

export interface AuthRegisterInput {
  username: string
  phone: string
  password: string
  otp: string
}

export interface AuthLoginWithPasswordInput {
  username_or_phone: string
  password: string
}

export interface AuthLoginWithPhoneInput {
  phone: string
  otp: string
}

export interface AuthSendOtpInput {
  phone: string
  purpose: string
}

export interface AuthOtpCooldownInput {
  identity_token: string
  phone?: string
}
