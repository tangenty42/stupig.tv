import type { User } from '@shared/types/user'
import type { H3Event } from 'h3'
import { runtime_config } from '@config/loader'
import { ApiError } from '@server/errors/ApiError'
import jwt from 'jsonwebtoken'

const config = runtime_config()

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
  const token = jwt.sign(
    { sub: user_id, jti: crypto.randomUUID() },
    config.app.auth.jwt.secret,
    { expiresIn: config.app.auth.jwt.expiresInDays * 86400 },
  )

  // Read `exp` back off the signed token instead of recomputing it from
  // JWT_EXPIRES_IN_DAYS, so a token generation's stored expiry cannot drift from
  // the JWT it belongs to.
  const { exp } = verify_jwt_payload(jwt.decode(token) as jwt.JwtPayload)

  return { token, exp }
}

export function verify_auth_token(token: string) {
  const decoded = jwt.verify(token, config.app.auth.jwt.secret)
  if (typeof decoded === 'string') {
    throw new ApiError(401, '登录状态已过期，请重新登录')
  }
  return verify_jwt_payload(decoded)
}

// True once a token has `within_days` or less left, i.e. it is time to hand the
// client a fresh one so an active session never hits the JWT expiry.
export function is_auth_token_expiring(exp: number, within_days: number) {
  const remaining_seconds = exp - Math.floor(Date.now() / 1000)
  return remaining_seconds <= within_days * 86400
}

export async function make_token_hash(token: string) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))
  return Buffer.from(hash).toString('hex')
}

export function get_auth_token_from_cookie(event: H3Event) {
  return getCookie(event, config.app.auth.cookie.tokenName) || null
}

// The token is a bearer credential, so the cookie is written only by the server
// and marked httpOnly: a script injected into the page cannot read it. `secure`
// is hardcoded because the credential's whole value depends on it never
// travelling in the clear — browsers treat localhost as a secure context, so
// development over http still works.
const AUTH_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: true,
  sameSite: 'lax',
  path: '/',
} as const

export function set_auth_token_cookie(event: H3Event, token: string) {
  setCookie(event, config.app.auth.cookie.tokenName, token, {
    ... AUTH_COOKIE_OPTIONS,
    maxAge: config.app.auth.cookie.maxAgeDays * 86400,
  })
}

export function clear_auth_token_cookie(event: H3Event) {
  deleteCookie(event, config.app.auth.cookie.tokenName, AUTH_COOKIE_OPTIONS)
}

// The header renders from this cookie, and unlike the token it is readable by
// the client (that is how the UI knows who is signed in). Its lifetime has to
// keep up with the token's: the token cookie is rewritten on every rotation
// while this one would keep its original expiry, so after COOKIE_MAX_AGE_DAYS
// the UI would show a signed-out state while the session behind it is still
// perfectly valid — a re-login nobody asked for. Refresh it wherever the token
// is refreshed to keep the pair in step.
//
// The value is JSON since the client decodes it with JSON.parse; h3 encodes the
// string with encodeURIComponent, which is what Nuxt's useCookie expects.
export function set_auth_user_cookie(event: H3Event, user: User) {
  setCookie(event, config.app.auth.cookie.userName, JSON.stringify(user), {
    sameSite: 'lax',
    path: '/',
    maxAge: config.app.auth.cookie.maxAgeDays * 86400,
  })
}

export function get_client_ip(event: H3Event) {
  const forwarded = getHeader(event, 'x-forwarded-for')
  if (forwarded) {
    return forwarded.split(',')[0]?.trim() ?? null
  }
  return event.node.req.socket.remoteAddress ?? null
}
