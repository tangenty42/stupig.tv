import crypto from 'node:crypto'
import { runtime_config } from '@config/loader'

const config = runtime_config()

declare module 'h3' {
  interface H3EventContext {
    identity_token?: string
  }
}

// Mints/reads a stable device identity cookie on every request and exposes it as
// event.context.identity_token. Used by the OTP endpoints (rate limiting) and by
// login (to associate a session row with a device).
export default defineEventHandler((event) => {
  let identity_token = getCookie(event, config.app.identity.cookieName)

  if (! identity_token) {
    identity_token = crypto.randomUUID()
    setCookie(event, config.app.identity.cookieName, identity_token, {
      // httpOnly: true,
      sameSite: 'lax',
      secure: true,
      maxAge: config.app.identity.cookieMaxAgeDays * 86400,
    })
  }

  event.context.identity_token = identity_token
})
