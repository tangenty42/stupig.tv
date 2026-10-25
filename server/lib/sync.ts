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
