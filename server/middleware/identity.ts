import crypto from 'node:crypto'
import { env } from '@shared/env'

declare module 'h3' {
  interface H3EventContext {
    identity_token?: string
  }
}

// Mints/reads a stable device identity cookie on every request and exposes it as
// event.context.identity_token. Used by the OTP endpoints (rate limiting) and by
// login (to associate a session row with a device).
export default defineEventHandler((event) => {
  let identity_token = getCookie(event, env.IDENTITY_COOKIE_NAME)

  if (! identity_token) {
    identity_token = crypto.randomUUID()
    setCookie(event, env.IDENTITY_COOKIE_NAME, identity_token, {
      // httpOnly: true,
      sameSite: 'lax',
      secure: true,
      maxAge: env.IDENTITY_COOKIE_MAX_AGE_DAYS * 86400,
    })
  }

  event.context.identity_token = identity_token
})
