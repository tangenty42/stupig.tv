import type { ContentAttachmentWorkspace, ContentStoryAttachment } from '@shared/types/content'
import type { ContentUploadSession } from '@shared/types/content-upload'
import type { UploadProgress } from './browser-upload'
import type { useApi } from '~/composables/useApi'
import type { createContentUploadResource } from '~/composables/useContentUploadResource'
import { settings } from '@shared/settings'
import { reactive } from 'vue'
import { get_error_status } from '~/composables/useApi'
import { create_browser_upload } from './browser-upload'
import { delete_upload_file_handle, load_upload_file_handle, save_upload_file_handle, upload_session_handle_key } from './upload-file-handle'

type UploadApi = Pick<ReturnType<typeof useApi>['content'], 'get_upload_session' | 'resume_upload_session' | 'initialize_upload_session' | 'sign_upload_session_part' | 'seal_upload_session' | 'cancel_upload_session' | 'adopt_upload_session'>

export function upload_session_unavailable(error: unknown) {
  return [401, 403, 404].includes(get_error_status(error) ?? 0)
    || (get_error_status(error) === 409 && (error as { code?: string }).code === 'UPLOAD_SESSION_EXPIRED')
}

/** Client-only byte sources and drivers. No component, cookie, MQTT or DOM ownership. */
export function create_upload_runtime(scope: number, actor: () => number | null, api: UploadApi, resource: ReturnType<typeof createContentUploadResource>, on_completed: (id: string, attachment?: ContentStoryAttachment | null) => void, accept_workspace: (workspace: ContentAttachmentWorkspace) => void) {
  const progress = reactive(new Map<string, UploadProgress>())
  const errors = reactive(new Map<string, string>())
  const active = reactive(new Set<string>())
  const queued = reactive(new Set<string>())
  const finalizing = reactive(new Set<string>())
  const paused = new Set<string>()
  const files = new Map<string, File>()
  const handles = new Map<string, FileSystemFileHandle>()
  const drivers = new Map<string, ReturnType<typeof create_browser_upload>>()
  const runs = new Map<string, symbol>()
  const lookups = new Set<string>()
  const saves = new Map<string, Promise<unknown>>()
  const db_name = settings.app.content.upload.handleStorageName
  let generation = 0
  const current = (epoch: number, id: string) => epoch === generation && ! resource.removed.has(id)
  const key = (id: string) => actor() === null ? null : upload_session_handle_key(actor()!, scope, id)
  async function attach(id: string, file: File, handle?: FileSystemFileHandle | null) {
    files.set(id, file)
    if (! handle)
      return
    handles.set(id, handle)
    const storage_key = key(id)
    if (! storage_key)
      return
    // Browser storage is optional. Its failure must not reject an accepted upload.
    const saved = save_upload_file_handle(db_name, storage_key, { file_name: file.name, file_size: file.size, handle }).catch(() => {})
    saves.set(id, saved)
    await saved
  }
  async function source(id: string, epoch: number) {
    if (files.has(id))
      return files.get(id)
    try {
      const storage_key = key(id)
      const handle = handles.get(id) ?? (storage_key ? await load_upload_file_handle(db_name, storage_key) : null)?.handle
      if (! current(epoch, id) || ! handle)
        return
      handles.set(id, handle)
      if (await handle.queryPermission({ mode: 'read' }) !== 'granted')
        return
      const file = await handle.getFile()
      if (current(epoch, id)) {
        files.set(id, file)
        return file
      }
    }
    catch {
      // Missing/revoked handles fall back to the existing original-file picker.
    }
  }
  function stop_driver(id: string) {
    paused.add(id)
    queued.delete(id)
    runs.delete(id)
    drivers.get(id)?.pause()
    drivers.delete(id)
    active.delete(id)
  }
  function pause(id: string) {
    stop_driver(id)
    finalizing.delete(id)
  }
  function observe_finalization(state: ContentUploadSession) {
    if (errors.has(state.id) || paused.has(state.id))
      return
    if (['cancelled', 'expired', 'failed'].includes(state.status) || state.image_status === 'failed')
      finalizing.delete(state.id)
    else if (['verifying', 'completed'].includes(state.status) || state.image_status)
      finalizing.add(state.id)
  }
  function complete(id: string, attachment?: ContentStoryAttachment | null, workspace?: ContentAttachmentWorkspace) {
    if (resource.removed.has(id))
      return
    const storage_key = key(id)
    const saved = saves.get(id) ?? Promise.resolve()
    if (storage_key)
      void saved.then(() => delete_upload_file_handle(db_name, storage_key)).catch(() => {})
    // Keep the fence while accepting the workspace and invoking landing hooks:
    // these synchronously hand ownership to the draft reference rewrite.
    stop_driver(id)
    if (workspace)
      accept_workspace(workspace)
    resource.remove(id)
    files.delete(id)
    handles.delete(id)
    saves.delete(id)
    progress.delete(id)
    errors.delete(id)
    paused.delete(id)
    try {
      on_completed(id, attachment)
    }
    finally {
      finalizing.delete(id)
    }
  }
  function failed(id: string, error: unknown) {
    finalizing.delete(id)
    if (upload_session_unavailable(error))
      complete(id)
    else
      errors.set(id, error instanceof Error ? error.message : '查询上传会话失败，请重试')
  }
  async function reconcile(id: string) {
    if (lookups.has(id) || resource.removed.has(id))
      return
    const epoch = generation
    lookups.add(id)
    const known = resource.state.value.sessions.find(item => item.id === id)
    if (known)
      observe_finalization(known)
    try {
      const state = await api.get_upload_session(id)
      if (! current(epoch, id))
        return
      const previous = resource.state.value.sessions.find(item => item.id === id)
      if (previous && (previous.revision ?? 0) > (state.revision ?? 0))
        return
      observe_finalization(state)
      if (state.status === 'completed') {
        finalizing.add(id)
        const receipt = await api.adopt_upload_session(id)
        if (current(epoch, id))
          complete(id, receipt.attachment, receipt.workspace)
      }
      else if (['cancelled', 'expired', 'failed'].includes(state.status)) {
        complete(id)
      }
      else {
        resource.update(state)
      }
    }
    catch (error) {
      if (current(epoch, id))
        failed(id, error)
    }
    finally {
      if (epoch === generation)
        lookups.delete(id)
    }
  }
  async function resume(id: string, file?: File) {
    if (active.has(id) || resource.removed.has(id))
      return true
    const state = resource.state.value.sessions.find(item => item.id === id)
    if (! state)
      return true
    const epoch = generation
    const token = Symbol(id)
    const live = () => current(epoch, id) && runs.get(id) === token
    runs.set(id, token)
    active.add(id)
    paused.delete(id)
    queued.delete(id)
    errors.delete(id)
    observe_finalization(state)
    if (file)
      files.set(id, file)
    try {
      const needs_bytes = ! state.image_status && ! ['ready', 'completed'].includes(state.status)
      if (! needs_bytes)
        finalizing.add(id)
      const input = needs_bytes ? await source(id, epoch) : undefined
      if (! live())
        return true
      if (needs_bytes && ! input) {
        finalizing.delete(id)
        return false
      }
      const driver = input
        ? create_browser_upload({
            resume: () => api.resume_upload_session(id), initialize: () => api.initialize_upload_session(id),
            sign: (part, md5) => api.sign_upload_session_part(id, part, md5),
            seal: () => {
              if (live())
                finalizing.add(id)
              return api.seal_upload_session(id)
            },
            cancel: () => api.cancel_upload_session(id),
          }, value => live() && progress.set(id, value))
        : null
      if (driver)
        drivers.set(id, driver)
      const ready = state.image_status ? await api.resume_upload_session(id) : driver ? await driver.run(input!) : await api.get_upload_session(id)
      if (! live())
        return true
      resource.update(ready)
      observe_finalization(ready)
      if (ready.image_status && ready.status !== 'completed')
        return true
      finalizing.add(id)
      const receipt = await api.adopt_upload_session(id)
      if (live())
        complete(id, receipt.attachment, receipt.workspace)
    }
    catch (error) {
      if (live() && ! (error instanceof DOMException && error.name === 'AbortError'))
        failed(id, error)
    }
    finally {
      if (runs.get(id) === token) {
        runs.delete(id)
        drivers.delete(id)
        active.delete(id)
      }
    }
    return true
  }
  async function cancel(id: string) {
    const epoch = generation
    stop_driver(id)
    finalizing.add(id)
    try {
      const state = await api.cancel_upload_session(id)
      if (! current(epoch, id))
        return
      if (state.status === 'completed') {
        const receipt = await api.adopt_upload_session(id)
        if (current(epoch, id))
          complete(id, receipt.attachment, receipt.workspace)
      }
      else if (['cancelled', 'expired', 'failed'].includes(state.status)) {
        complete(id)
      }
      else {
        resource.update(state)
        throw new Error('取消尚未确认，请重试查询')
      }
    }
    finally {
      if (epoch === generation)
        finalizing.delete(id)
    }
  }
  function reset() {
    generation ++
    for (const driver of drivers.values())
      driver.pause()
    drivers.clear()
    runs.clear()
    lookups.clear()
    saves.clear()
    files.clear()
    handles.clear()
    active.clear()
    queued.clear()
    finalizing.clear()
    paused.clear()
    progress.clear()
    errors.clear()
  }
  return { progress, errors, active, queued, finalizing, paused, observe_finalization, attach, reconcile, resume, pause, cancel, reset, has_file: (id: string) => files.has(id) }
}
