import { settings } from './settings'

/** One derived duration, shared by the server and the conservative client clock. */
export function draft_lease_ms() {
  const config = settings.app.content.draft
  return config.keepaliveIntervalMs + 2 * config.requestTimeoutMs + config.leaseMarginMs
}
