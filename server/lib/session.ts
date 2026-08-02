import type { H3Event } from 'h3'
import { ApiError } from '@server/errors/ApiError'
import { env } from '@shared/env'
import jwt from 'jsonwebtoken'

function verify_jwt_payload(payload: jwt.JwtPayload) {
  if (typeof payload.sub !== 'number' || typeof payload.jti !== 'string' || typeof payload.iat !== 'number' || typeof payload.exp !== 'number') {
    throw new ApiError(401, '登录状态已过期，请重新登录')
  }
  return {
    sub: payload.sub,
    jti: payload.jti,
    iat: payload.iat,
    exp: payload.exp,
  }
}

export function sign_auth_token(user_id: number) {
  return jwt.sign(
    { sub: user_id, jti: crypto.randomUUID() },
    env.JWT_SECRET,
    { expiresIn: env.JWT_EXPIRES_IN as jwt.SignOptions['expiresIn'] },
  )
}

export function verify_auth_token(token: string) {
  const decoded = jwt.verify(token, env.JWT_SECRET)
  if (typeof decoded === 'string') {
    throw new ApiError(401, '登录状态已过期，请重新登录')
  }
  return verify_jwt_payload(decoded)
}

export async function make_token_hash(token: string) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))
  return Buffer.from(hash).toString('hex')
}

export function get_auth_token_from_cookie(event: H3Event) {
  return getCookie(event, env.AUTH_TOKEN_COOKIE_NAME) || null
}

export function get_client_ip(event: H3Event) {
  const forwarded = getHeader(event, 'x-forwarded-for')
  if (forwarded) {
    return forwarded.split(',')[0]?.trim() ?? null
  }
  return event.node.req.socket.remoteAddress ?? null
}
