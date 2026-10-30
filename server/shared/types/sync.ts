// Sync resource types shared between client and server. A resource string is
// `<type>:<id>`; use sync_resource() to build it so the type stays constrained.

export type SyncResourceType = 'profile' | 'profile_sessions' | 'auth_user' | 'otp_cooldown' | 'otp_cooldown_by_identity' | 'user_login_sessions' | 'content_stories' | 'content_story' | 'content_titles' | 'content_attachments' | 'content_upload_session' | 'content_uploads' | 'content_draft' | 'content_drafts'

export function sync_resource(type: SyncResourceType, id: string | number) {
  return `${type}:${id}`
}

export interface DataSyncEvent {
  id: string
  type: 'refresh' | 'sync'
  resource: string
  sync_all?: boolean
  dirty_resources?: string[]
  timestamp: number
}
