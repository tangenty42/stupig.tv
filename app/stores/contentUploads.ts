import type { ContentAttachmentWorkspace, ContentStoryAttachment } from '@shared/types/content'
import type { ContentUploadReservation, ContentUploadSession } from '@shared/types/content-upload'
import type { LoginUser } from '~/composables/useAuth'
import { has_permission } from '@shared/permissions'
import { settings } from '@shared/settings'
import { defineStore } from 'pinia'
import { createContentUploadAdmission } from '~/composables/useContentUploadAdmission'
import { createContentUploadResource } from '~/composables/useContentUploadResource'
import { accept_attachment_snapshot } from '~/utils/content/attachment-snapshot'
import { create_upload_runtime } from '~/utils/content/upload-runtime'

export type { UploadEntry } from '~/composables/useContentUploadAdmission'

/** Durable state comes from the API; File and SDK drivers remain client-only closures. */
export function useContentUploadsStore(scope: number) {
  return defineStore(`content-uploads:${scope}`, () => {
    const { content } = useApi()
    const user = useCookie<LoginUser | null>(settings.app.auth.cookie.userName)
    const identity_key = computed(() => `${user.value?.id ?? 'anonymous'}:${has_permission(user.value, 'content_manage', 'full')}:${has_permission(user.value, 'content_private', 'read')}`)
    const resource = createContentUploadResource(scope)
    const workspace = useState<ContentAttachmentWorkspace | null>(`content_attachment_workspace:${scope}`, () => null)
    const sessions = computed(() => resource.state.value.sessions)
    const enabled = computed(() => resource.state.value.enabled)
    const ready = computed(() => resource.state.value.ready)
    const reservations = computed(() => {
      const own = new Map(sessions.value.map(session => [session.id, session]))
      const all = new Map(resource.state.value.reservations.filter(item => ! resource.removed.has(item.id) && ! own.has(item.id)).map(item => [item.id, item]))
      for (const session of sessions.value) {
        if (! ['completed', 'cancelled', 'expired', 'failed'].includes(session.status))
          all.set(session.id, { id: session.id, path: session.path, parent_id: session.parent_id, source_id: session.source_id, replacement_id: session.replacement_id })
      }
      return [... all.values()]
    })
    const landed = new Map<string, (attachment: ContentStoryAttachment) => void>()
    const runtime = create_upload_runtime(scope, () => user.value?.id ?? null, content, resource, (id, attachment) => {
      const callback = landed.get(id)
      landed.delete(id)
      if (attachment)
        callback?.(attachment)
    }, (incoming) => {
      workspace.value = accept_attachment_snapshot(workspace.value, incoming)
    })
    const { progress, errors, active, queued, finalizing, resume, pause, cancel, has_file } = runtime
    let generation = 0
    const snapshot_epoch = () => generation
    const admission = createContentUploadAdmission(scope, {
      snapshot_epoch,
      begin_upload_batch: content.begin_upload_batch,
      async attach(session, entry) {
        resource.update(session)
        queued.add(session.id)
        if (entry.on_landed)
          landed.set(session.id, entry.on_landed)
        await runtime.attach(session.id, entry.file, entry.handle)
      },
      is_paused: id => runtime.paused.has(id),
      resume,
    })
    const { preparing, resolution, report, admission_error, admitting, submit, dismiss_resolution, start } = admission
    const busy = computed(() => preparing.value !== null || active.size > 0)
    function apply_list(value: { enabled: boolean, sessions: ContentUploadSession[], reservations?: ContentUploadReservation[] }, epoch = generation) {
      if (epoch !== generation)
        return
      for (const session of resource.merge(value))
        void runtime.reconcile(session.id)
      for (const session of resource.state.value.sessions)
        runtime.observe_finalization(session)
    }
    function reset() {
      generation ++
      admission.reset()
      runtime.reset()
      resource.reset()
      landed.clear()
    }
    // Pinia's own effect scope survives the component that first created it.
    watch(identity_key, reset, { flush: 'sync' })
    return { identity_key, snapshot_epoch, enabled, ready, sessions, reservations, progress, errors, active, queued, finalizing, preparing, busy, resolution, report, admission_error, admitting, submit, dismiss_resolution, has_file, apply_list, start, resume, pause, cancel, reset }
  })()
}
