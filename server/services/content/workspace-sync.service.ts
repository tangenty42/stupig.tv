import type { Connection } from 'mysql2/promise'
import type { WorkspaceChange } from './workspace-change'
import { sync_resource } from '@shared/types/sync'
import { enqueue_content_refresh } from './sync-outbox.repository'
import { legacy_workspace_change } from './workspace-change'

/** Persist on the business connection, including successful receipt replay. */
export async function enqueue_workspace_change(connection: Pick<Connection, 'execute'>, scope: number, change: WorkspaceChange = legacy_workspace_change) {
  const resources: string[] = []
  if (change.attachments)
    resources.push(sync_resource('content_attachments', scope))
  if (change.story)
    resources.push(sync_resource('content_story', scope))
  if (change.stories)
    resources.push(sync_resource('content_stories', 'all'))
  if (change.uploads || change.upload_sessions?.length)
    resources.push(sync_resource('content_uploads', scope))
  for (const session of new Set(change.upload_sessions))
    resources.push(sync_resource('content_upload_session', session))
  await enqueue_content_refresh(connection, resources)
}
