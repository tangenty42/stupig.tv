// Sync resource types shared between client and server. A resource string is
// `<type>:<id>`; use sync_resource() to build it so the type stays constrained.
import type { ContentTaskProgressSnapshot } from './content'

export type SyncResourceType = 'profile' | 'profile_sessions' | 'auth_user' | 'otp_cooldown' | 'otp_cooldown_by_identity' | 'user_login_sessions' | 'user_login_sessions_by_identity' | 'user_login_sessions_by_phone' | 'user_login_sessions_by_username' | 'user_login_sessions_by_email' | 'content_stories' | 'content_story' | 'content_story_tasks'

export function sync_resource(type: SyncResourceType, id: string | number) {
  return `${type}:${id}`
}

export interface DataSyncEvent {
  id: string
  type: 'refresh' | 'sync' | 'task_progress'
  resource: string
  sync_all?: boolean
  dirty_resources?: string[]
  /**
   * Only on `task_progress`: the task state itself, carried inline so a
   * subscriber applies progress without refetching on every tick.
   */
  task_snapshot?: ContentTaskProgressSnapshot
  timestamp: number
}
