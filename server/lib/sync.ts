import type { ContentTaskProgressSnapshot } from '@shared/types/content'
import type { DataSyncEvent } from '@shared/types/sync'
import { sync_resource } from '@shared/types/sync'
import { publish_sync } from './mqtt'

export { sync_resource }

function next_event_id() {
  return `${Date.now()}-${Math.random().toString(36)
    .slice(2, 9)}`
}

export function publish_refresh(event: Omit<DataSyncEvent, 'id' | 'type' | 'timestamp'>) {
  const payload: DataSyncEvent = {
    id: next_event_id(),
    type: 'refresh',
    ... event,
    timestamp: Date.now(),
  }

  publish_sync(payload.resource, JSON.stringify(payload))
}

/**
 * Pushes live task state instead of a refetch hint.
 *
 * Progress ticks arrive many times per upload, and "notify then refetch" would
 * turn each one into a round trip per subscriber; carrying the snapshot keeps
 * progress a payload-only update. Membership changes (a task appearing or
 * reaching a terminal state) still go through `publish_refresh`.
 */
export function publish_task_snapshot(snapshot: ContentTaskProgressSnapshot) {
  const resource = sync_resource('content_story_tasks', snapshot.scope_id)
  const payload: DataSyncEvent = {
    id: next_event_id(),
    type: 'task_progress',
    resource,
    task_snapshot: snapshot,
    timestamp: Date.now(),
  }

  publish_sync(resource, JSON.stringify(payload))
}
