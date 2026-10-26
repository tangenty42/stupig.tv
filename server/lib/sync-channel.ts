import { createHmac } from 'node:crypto'
import { runtime_config } from '@config/loader'

// Server-only channel derivation for sync resources whose ids are personal
// identifiers (phone numbers, device identity tokens). Those ids must not
// travel in the clear: MQTT topic names and event payloads are readable by
// subscribe-only broker connections, and unlike the earlier shared sha256
// scheme an unkeyed digest is trivially reversed against the small phone
// number space. Here the id is replaced by a keyed HMAC truncated to 128
// bits, so only the server can name a channel; browsers receive the channel
// strings from the API (see otp_cooldown_channels) and treat them as opaque.
//
// The MAC key is a domain-separated subkey of the auth JWT secret: no extra
// deployment secret to manage, and rotating JWT_SECRET rotates every channel
// with it. The `v1.` version prefix leaves room for an explicit re-key later;
// channels are re-issued on every cooldown query, so clients follow a rotation
// on their next fetch. Keep this file out of the frozen TS-migration closure
// (scripts/migration/frozen.test.ts); it must stay server-side regardless,
// because the key may never reach the browser bundle.
const channel_key = createHmac('sha256', runtime_config().app.auth.jwt.secret)
  .update('stupig:sync-channel:v1')
  .digest()

const secret_id_types = new Set<string>([
  'otp_cooldown',
  'otp_cooldown_by_identity',
  'user_login_sessions_by_identity',
  'user_login_sessions_by_phone',
  'user_login_sessions_by_username',
  'user_login_sessions_by_email',
])

/** Leave non-sensitive and malformed resources untouched; only MAC secret ids. */
export function wire_resource(resource: string) {
  const separator = resource.indexOf(':')
  if (separator === - 1) {
    return resource
  }
  const type = resource.slice(0, separator)
  if (! secret_id_types.has(type)) {
    return resource
  }
  const id = createHmac('sha256', channel_key).update(resource).digest('base64url').slice(0, 22)
  return `${type}:v1.${id}`
}

/** Channels a cooldown subscriber should watch: per typed phone and per device identity. */
export function otp_cooldown_channels(phone: string | undefined, identity_token: string) {
  return {
    phone: phone ? wire_resource(`otp_cooldown:${phone}`) : null,
    identity: wire_resource(`otp_cooldown_by_identity:${identity_token}`),
  }
}
