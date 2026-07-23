export interface OtpCooldownResult {
  can_send: boolean
  next_available_at: string | null
}
