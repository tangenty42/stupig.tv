export interface SessionRecord {
  id: number
  identity_token: string | null
  is_logged_out: boolean
  is_expired: boolean
  is_online: boolean
  login_at: string
  last_seen_at: string
  logout_at: string | null
  expires_at: string
  login_ip: string | null
  last_seen_ip: string | null
  user_agent: string | null
  is_current: boolean
}

export interface SessionOverview {
  records: SessionRecord[]
}
