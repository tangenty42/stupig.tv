import type { ContentAttachmentWorkspace } from '@shared/types/content'
import type { ContentUploadSession } from '@shared/types/content-upload'
import type { UploadSessionApi } from '~/utils/content/browser-upload'
import { error_policy_schema } from '@shared/content-workspace'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, expect, it, vi } from 'vitest'
import { computed, effectScope, reactive, ref, watch } from 'vue'
import { project_workspace_rows } from '~/utils/content/workspace'

const state = vi.hoisted(() => ({
  api: { begin_upload_batch: vi.fn(), adopt_upload_session: vi.fn(), get_upload_session: vi.fn(), resume_upload_session: vi.fn(), initialize_upload_session: vi.fn(), sign_upload_session_part: vi.fn(), seal_upload_session: vi.fn(), cancel_upload_session: vi.fn() },
  hash: vi.fn(), run: vi.fn(), pause: vi.fn(),
  save_handle: vi.fn(), load_handle: vi.fn(), delete_handle: vi.fn(),
  driver_apis: [] as UploadSessionApi[],
}))
const user = ref<{ id: number, is_admin: boolean }>({ id: 7, is_admin: true })
const resources = new Map<string, ReturnType<typeof ref>>()
vi.stubGlobal('ref', ref)
vi.stubGlobal('reactive', reactive)
vi.stubGlobal('computed', computed)
vi.stubGlobal('watch', watch)
vi.stubGlobal('useCookie', () => user)
vi.stubGlobal('useState', (key: string, init: () => unknown) => {
  if (! resources.has(key))
    resources.set(key, ref(init()))
  return resources.get(key)
})
vi.stubGlobal('useApi', () => ({ content: state.api }))
vi.mock('~/utils/content/browser-upload', () => ({ upload_file_sha256: state.hash, create_browser_upload: (api: UploadSessionApi) => {
  state.driver_apis.push(api)
  return { run: state.run, pause: state.pause }
} }))
vi.mock('~/utils/content/upload-file-handle', async original => ({
  ... await original<typeof import('~/utils/content/upload-file-handle')>(),
  save_upload_file_handle: state.save_handle, load_upload_file_handle: state.load_handle, delete_upload_file_handle: state.delete_handle,
}))
const { useContentUploadsStore } = await import('./contentUploads')
const session = { id: 'a'.repeat(32), scope_id: 24, status: 'ready', path: 'a.txt', size: 3, sha256: 'a'.repeat(64), parts: [], target: { bucket: 'test', region: 'test', endpoint: 'https://test' }, key: 'staging/key', upload_id: 'upload', part_size: 262144, object_etag: 'etag' } satisfies ContentUploadSession
beforeEach(() => {
  setActivePinia(createPinia())
  vi.resetAllMocks()
  state.driver_apis.length = 0
  resources.clear()
  user.value = { id: 7, is_admin: true }
  state.save_handle.mockResolvedValue(undefined)
  state.load_handle.mockResolvedValue(null)
  state.delete_handle.mockResolvedValue(undefined)
  state.hash.mockResolvedValue(session.sha256)
  // Admission precedes bytes; a ready session would skip the transfer under test.
  state.api.begin_upload_batch.mockResolvedValue({ accepted: [{ index: 0, session_id: session.id, path: session.path }], sessions: [{ ... session, status: 'queued' }], succeeded: [session.path], skipped: [], renamed: [] })
  state.api.cancel_upload_session.mockResolvedValue({ ... session, status: 'cancelled' })
  state.api.get_upload_session.mockResolvedValue(session)
  state.run.mockResolvedValue(session)
  state.api.adopt_upload_session.mockResolvedValue({ attachment: { id: 9, file_name: 'a.txt' } })
})

it('publishes only after verified upload and delivers the returned attachment once', async () => {
  const store = useContentUploadsStore(24)
  const on_landed = vi.fn()
  await store.start([{ file: new File(['abc'], 'a.txt'), file_name: 'a.txt', on_landed }])
  expect(state.api.begin_upload_batch.mock.calls[0]![0]).toMatchObject({ scope_id: 24, entries: [{ path: 'a.txt', sha256: session.sha256, purpose: 'create' }] })
  await vi.waitFor(() => expect(on_landed).toHaveBeenCalledOnce())
  expect(state.api.adopt_upload_session).toHaveBeenCalledWith(session.id)
  expect(on_landed).toHaveBeenCalledOnce()
  expect(store.sessions).toEqual([])
  expect(store.busy).toBe(false)
  store.apply_list({ enabled: true, sessions: [session] })
  expect(store.sessions).toEqual([])
})

it('fences the complete seal/receipt/landing interval while leaving byte transfer editable', async () => {
  const store = useContentUploadsStore(24)
  let seal!: (value: ContentUploadSession) => void
  let publish!: (value: unknown) => void
  state.api.seal_upload_session.mockImplementation(() => new Promise(resolve => seal = resolve))
  state.api.adopt_upload_session.mockImplementation(() => new Promise(resolve => publish = resolve))
  state.run.mockImplementation(async () => {
    expect(store.finalizing.size).toBe(0)
    return await state.driver_apis[0]!.seal()
  })
  const on_landed = vi.fn(() => expect(store.finalizing.has(session.id)).toBe(true))
  await store.start([{ file: new File(['abc'], 'a.txt'), file_name: 'a.txt', on_landed }])
  await vi.waitFor(() => expect(state.api.seal_upload_session).toHaveBeenCalledOnce())
  expect(store.finalizing.has(session.id)).toBe(true)
  seal(session)
  await vi.waitFor(() => expect(state.api.adopt_upload_session).toHaveBeenCalledOnce())
  expect(store.finalizing.has(session.id)).toBe(true)
  publish({ attachment: { id: 9, file_name: 'a.txt' } })
  await vi.waitFor(() => expect(on_landed).toHaveBeenCalledOnce())
  expect(store.finalizing.size).toBe(0)
})

it('keeps background image publication fenced through a delayed completion receipt', async () => {
  const store = useContentUploadsStore(24)
  state.run.mockResolvedValue({ ... session, image_status: 'queued' })
  await store.start([{ file: new File(['abc'], 'a.png'), file_name: 'a.png' }])
  await vi.waitFor(() => expect(store.active.size).toBe(0))
  expect(store.finalizing.has(session.id)).toBe(true)
  let publish!: (value: unknown) => void
  state.api.adopt_upload_session.mockImplementation(() => new Promise(resolve => publish = resolve))
  state.api.get_upload_session.mockResolvedValue({ ... session, status: 'completed', image_status: 'completed' })
  store.apply_list({ enabled: true, sessions: [] })
  await vi.waitFor(() => expect(state.api.adopt_upload_session).toHaveBeenCalledOnce())
  expect(store.finalizing.has(session.id)).toBe(true)
  publish({ attachment: { id: 9, file_name: 'a.png' } })
  await vi.waitFor(() => expect(store.sessions).toEqual([]))
  expect(store.finalizing.size).toBe(0)
})

it.each(['error', 'pause', 'reset'] as const)('releases the finalization fence on %s', async (outcome) => {
  const store = useContentUploadsStore(24)
  store.apply_list({ enabled: true, sessions: [session] })
  let reject!: (error: Error) => void
  state.api.adopt_upload_session.mockImplementation(() => new Promise((_resolve, fail) => reject = fail))
  const pending = store.resume(session.id)
  await vi.waitFor(() => expect(state.api.adopt_upload_session).toHaveBeenCalledOnce())
  expect(store.finalizing.has(session.id)).toBe(true)
  if (outcome === 'pause')
    store.pause(session.id)
  if (outcome === 'reset')
    store.reset()
  reject(new Error('offline'))
  await pending
  expect(store.finalizing.size).toBe(0)
  if (outcome === 'error') {
    store.apply_list({ enabled: true, sessions: [session] })
    expect(store.finalizing.size).toBe(0)
  }
})

it.each([false, true])('passes .good file and directory declarations through real admission preparation (folder=%s)', async (folder) => {
  state.api.begin_upload_batch.mockResolvedValue({ accepted: [], sessions: [], succeeded: [], skipped: [], renamed: [] })
  const paths = folder ? ['album.good/sub/Photo.PNG', 'album.good/sub/other.txt.good'] : ['public.PNG', 'secret.PNG.good', 'second.GIF.good']
  const store = useContentUploadsStore(24)
  await store.start(paths.map(path => ({ file: new File(['abc'], path.split('/').at(- 1)!), file_name: path, ... (folder ? { selection_root: 'album.good' } : {}) })))
  const input = state.api.begin_upload_batch.mock.calls[0]![0]
  expect(input.entries.map((entry: { path: string }) => entry.path)).toEqual(paths.map(path => path.replace('.PNG', '.png').replace('.GIF', '.gif')))
  expect(input.entries.every((entry: { selection_root?: string }) => entry.selection_root === (folder ? 'album.good' : undefined))).toBe(true)
  expect(state.hash).toHaveBeenCalledTimes(paths.length)
})

it.each([
  ['receipt-first', false], ['snapshot-first', false], ['newer-deletion', false],
  ['receipt-first', true], ['snapshot-first', true], ['newer-deletion', true],
] as const)('hands the upload to a coherent namespace without duplicates or an empty frame: %s, replace=%s', async (order, replacing) => {
  const file = { id: 9, file_name: 'a.txt', file_size: 3, mime_type: 'text/plain', is_image: false, is_encrypted: false, version: 'v2', url: '/file' }
  const published: ContentAttachmentWorkspace = { root_id: 1, nodes: [{ id: 9, parent_id: 1, name: 'a.txt', path: 'a.txt', kind: 'file', version: 'node-v2', attachment: file }], attachments: [file], folders: [], namespace_revision: 2, viewer_key: '7:true' }
  const old_file = { ... file, file_name: 'old.txt', version: 'v1' }
  const workspace = ref<ContentAttachmentWorkspace>({ ... published, nodes: replacing ? [{ ... published.nodes![0]!, name: 'old.txt', path: 'old.txt', version: 'node-v1', attachment: old_file }] : [], attachments: replacing ? [old_file] : [], namespace_revision: 1 })
  resources.set('content_attachment_workspace:24', workspace)
  const store = useContentUploadsStore(24)
  let finish!: (value: unknown) => void
  state.api.adopt_upload_session.mockImplementationOnce(() => new Promise(resolve => finish = resolve))
  store.apply_list({ enabled: true, sessions: [{ ... session, ... (replacing ? { purpose: 'replace', source_id: 9 } as const : {}) }] })
  const pending = store.resume(session.id)
  await vi.waitFor(() => expect(state.api.adopt_upload_session).toHaveBeenCalledOnce())
  const rows = computed(() => project_workspace_rows(workspace.value.nodes ?? [], store.sessions, 1, new Set()))
  const counts: number[] = []
  const stop = watch(rows, value => counts.push(value.length), { flush: 'sync' })
  if (order !== 'receipt-first')
    workspace.value = published
  if (order === 'newer-deletion')
    workspace.value = { ... published, namespace_revision: 3, nodes: [], attachments: [] }
  finish({ attachment: file, workspace: published })
  await pending
  stop()
  expect(store.sessions).toEqual([])
  if (order === 'newer-deletion') {
    expect(workspace.value.namespace_revision).toBe(3)
    expect(rows.value).toEqual([])
  }
  else {
    expect(rows.value).toHaveLength(1)
    expect(rows.value[0]?.node?.attachment).toEqual(file)
    expect(counts.length).toBeGreaterThan(0)
    expect(counts.every(count => count === 1)).toBe(true)
  }
})

it('projects remote reservations and immediate own receipts, releasing only a cancelled target', async () => {
  const store = useContentUploadsStore(24)
  const foreign = { id: 'foreign', path: 'remote.txt', parent_id: 1, source_id: 5 }
  const own = { ... session, status: 'uploading', path: 'current.txt', parent_id: 2, source_id: 4 }
  store.apply_list({ enabled: true, sessions: [own], reservations: [foreign, { id: session.id, path: 'stale.txt' }] })
  expect(store.reservations).toEqual([foreign, { id: session.id, path: 'current.txt', parent_id: 2, source_id: 4, replacement_id: undefined }])
  await store.cancel(session.id)
  expect(store.reservations).toEqual([foreign])
  const epoch = store.snapshot_epoch()
  user.value = { id: 8, is_admin: true }
  store.apply_list({ enabled: true, sessions: [], reservations: [foreign] }, epoch)
  expect(store.reservations).toEqual([])
})

it('leaves encoding to the server and receives completion through synchronized state without reuploading', async () => {
  const store = useContentUploadsStore(24)
  const on_landed = vi.fn()
  state.run.mockResolvedValue({ ... session, image_status: 'queued' })
  await store.start([{ file: new File(['abc'], 'image.png'), file_name: 'image.png', on_landed }])
  await vi.waitFor(() => expect(store.active.size).toBe(0))
  expect(store.sessions[0]?.image_status).toBe('queued')
  expect(state.api.adopt_upload_session).not.toHaveBeenCalled()
  state.api.get_upload_session.mockResolvedValue({ ... session, status: 'completed', image_status: 'completed' })
  store.apply_list({ enabled: true, sessions: [] })
  await vi.waitFor(() => expect(on_landed).toHaveBeenCalledOnce())
  expect(store.sessions).toEqual([])
  expect(state.run).toHaveBeenCalledOnce()
})

it('retries a failed image job using the existing sealed input without requiring a File', async () => {
  const store = useContentUploadsStore(24)
  store.apply_list({ enabled: true, sessions: [{ ... session, image_status: 'failed' }] })
  state.api.resume_upload_session.mockResolvedValue({ ... session, image_status: 'queued' })
  await store.resume(session.id)
  expect(state.api.resume_upload_session).toHaveBeenCalledWith(session.id)
  expect(state.run).not.toHaveBeenCalled()
  expect(state.api.adopt_upload_session).not.toHaveBeenCalled()
  expect(store.sessions[0]?.image_status).toBe('queued')
})

it('records the selected original filename independently of a replacement logical path', async () => {
  const store = useContentUploadsStore(24)
  await store.start([{ file: new File(['abc'], 'camera.PNG', { type: 'image/png' }), file_name: 'old.jpg', purpose: 'replace', source: { id: 9, version: 'v1' } }])
  expect(state.api.begin_upload_batch.mock.calls[0]![0].entries[0]).toMatchObject({ path: 'old.jpg', original_name: 'camera.PNG', content_type: 'image/png' })
  await vi.waitFor(() => expect(store.active.size).toBe(0))
})

it.each([
  ['create', 'Photo.JPG', 'Photo.jpg', undefined],
  ['create', 'Album.JPG/Camera/Photo.PNG', 'Album.JPG/Camera/Photo.png', 'Album.JPG'],
  ['create', 'Album.JPG/README', 'Album.JPG/README', 'Album.JPG'],
  ['replace', 'KeptName.JPG', 'KeptName.jpg', undefined],
  ['replace', 'Camera/SelectedName.PDF', 'Camera/SelectedName.pdf', undefined],
] as const)('normalizes the %s admission path %s while preserving the source File', async (purpose, path, expected, selection_root) => {
  const store = useContentUploadsStore(24)
  const file = new File(['abc'], 'Original.JPG')
  await store.start([{ file, file_name: path, purpose, selection_root, ... (purpose === 'replace' ? { source: { id: 9, version: 'v1' } } : {}) }])
  expect(state.api.begin_upload_batch.mock.calls[0]![0].entries[0]).toMatchObject({ path: expected, original_name: 'Original.JPG', purpose })
  expect(file.name).toBe('Original.JPG')
  expect(state.hash.mock.calls[0]![0]).toBe(file)
  await vi.waitFor(() => expect(store.active.size).toBe(0))
})

it('keeps a ready session after a lost publication response and retries without file bytes', async () => {
  const store = useContentUploadsStore(24)
  store.apply_list({ enabled: true, sessions: [session] })
  state.api.adopt_upload_session.mockRejectedValueOnce(new Error('回执丢失'))
  await store.resume(session.id)
  expect(store.sessions).toHaveLength(1)
  expect(store.errors.get(session.id)).toBe('回执丢失')
  await store.resume(session.id)
  expect(state.run).not.toHaveBeenCalled()
  expect(state.api.adopt_upload_session).toHaveBeenCalledTimes(2)
  expect(store.sessions).toEqual([])
})

it('does not publish after transfer failure and only removes a cancelled session after acknowledgement', async () => {
  const store = useContentUploadsStore(24)
  state.run.mockRejectedValueOnce(new Error('传输中断'))
  await store.start([{ file: new File(['abc'], 'a.txt'), file_name: 'a.txt' }])
  await vi.waitFor(() => expect(store.errors.get(session.id)).toBe('传输中断'))
  expect(state.api.adopt_upload_session).not.toHaveBeenCalled()
  expect(store.sessions).toHaveLength(1)
  state.api.cancel_upload_session.mockRejectedValueOnce(new Error('网络中断'))
  await expect(store.cancel(session.id)).rejects.toThrow('网络中断')
  expect(store.sessions).toHaveLength(1)
  await store.cancel(session.id)
  expect(store.sessions).toEqual([])
})

it('fences late upload results after identity reset', async () => {
  const store = useContentUploadsStore(24)
  let finish!: (value: ContentUploadSession) => void
  state.run.mockImplementation(() => new Promise<ContentUploadSession>((resolve) => {
    finish = resolve
  }))
  const start = store.start([{ file: new File(['abc'], 'a.txt'), file_name: 'a.txt' }])
  await vi.waitFor(() => expect(state.run).toHaveBeenCalledOnce())
  store.reset()
  finish(session)
  await start
  expect(state.pause).toHaveBeenCalled()
  expect(state.api.adopt_upload_session).not.toHaveBeenCalled()
  expect(store.sessions).toEqual([])
  expect(store.ready).toBe(false)
})

it('does not restore an authorized attachment snapshot from an old identity completion', async () => {
  const workspace = ref<ContentAttachmentWorkspace>({ attachments: [], folders: [], nodes: [], namespace_revision: 1, viewer_key: 'anon:false' })
  resources.set('content_attachment_workspace:24', workspace)
  const store = useContentUploadsStore(24)
  let finish!: (value: unknown) => void
  state.api.adopt_upload_session.mockImplementationOnce(() => new Promise(resolve => finish = resolve))
  store.apply_list({ enabled: true, sessions: [session] })
  const pending = store.resume(session.id)
  await vi.waitFor(() => expect(state.api.adopt_upload_session).toHaveBeenCalledOnce())
  user.value = { id: 8, is_admin: true }
  finish({ attachment: { id: 9 }, workspace: { ... workspace.value, viewer_key: '7:true', namespace_revision: 2, folders: ['private'] } })
  await pending
  expect(workspace.value).toMatchObject({ viewer_key: 'anon:false', namespace_revision: 1, folders: [] })
  expect(store.sessions).toEqual([])
})

it('keeps the request identity on network retry and changes it only after explicit business resolution', async () => {
  const store = useContentUploadsStore(24)
  state.api.begin_upload_batch.mockRejectedValueOnce(new Error('network'))
  await store.start([{ file: new File(['abc'], 'a.txt'), file_name: 'a.txt' }])
  const original = state.api.begin_upload_batch.mock.calls[0]![0].request_id
  expect(store.admission_error).toBe('network')
  expect(state.run).not.toHaveBeenCalled()
  state.api.begin_upload_batch.mockRejectedValueOnce({ code: 'BATCH_REJECTED', details: { items: [{ target: 'a.txt', category: 'name_conflict', code: 'NAME_TAKEN', reason: 'taken', allowed: ['fail', 'suffix'] }], valid_count: 0 } })
  await store.submit()
  expect(state.api.begin_upload_batch.mock.calls[1]![0].request_id).toBe(original)
  expect(store.resolution?.items[0]?.code).toBe('NAME_TAKEN')
  await store.submit(error_policy_schema.parse({ name_conflict: 'suffix' }))
  expect(state.api.begin_upload_batch.mock.calls[2]![0].request_id).not.toBe(original)
  expect(store.resolution).toBeNull()
  await vi.waitFor(() => expect(store.sessions).toEqual([]))
})

it('does not resurrect a cancelled row when a late transfer finishes', async () => {
  const store = useContentUploadsStore(24)
  let finish!: (value: ContentUploadSession) => void
  state.run.mockImplementation(() => new Promise<ContentUploadSession>((resolve) => {
    finish = resolve
  }))
  await store.start([{ file: new File(['abc'], 'a.txt'), file_name: 'a.txt' }])
  await store.cancel(session.id)
  finish(session)
  await vi.waitFor(() => expect(store.active.size).toBe(0))
  expect(store.sessions).toEqual([])
  expect(state.api.adopt_upload_session).not.toHaveBeenCalled()
})

it('keeps a newly accepted row across a stale list and rejects older revisions', async () => {
  const store = useContentUploadsStore(24)
  const current = { ... session, revision: 5, path: 'renamed/a.txt', status: 'uploading' }
  store.apply_list({ enabled: true, sessions: [current] })
  state.api.get_upload_session.mockResolvedValueOnce({ ... session, revision: 4, status: 'uploading' })
  store.apply_list({ enabled: true, sessions: [] })
  await Promise.resolve()
  expect(store.sessions).toMatchObject([{ revision: 5, path: 'renamed/a.txt' }])
})

it('a paused queued upload never starts when a worker becomes available', async () => {
  const store = useContentUploadsStore(24)
  const rows = Array.from({ length: 4 }, (_, index) => ({ ... session, id: String(index + 1).repeat(32), path: `${index}.txt`, status: 'queued' }))
  state.api.begin_upload_batch.mockResolvedValueOnce({ accepted: rows.map((row, index) => ({ index, session_id: row.id, path: row.path })), sessions: rows, succeeded: [], skipped: [], renamed: [] })
  const finish: (() => void)[] = []
  state.run.mockImplementation(() => new Promise<ContentUploadSession>((resolve) => {
    finish.push(() => resolve(session))
  }))
  await store.start(rows.map(row => ({ file: new File(['abc'], row.path), file_name: row.path })))
  expect(state.run).toHaveBeenCalledTimes(3)
  expect(store.queued.has(rows[3]!.id)).toBe(true)
  store.pause(rows[3]!.id)
  finish.forEach(resolve => resolve())
  await vi.waitFor(() => expect(store.active.size).toBe(0))
  expect(state.run).toHaveBeenCalledTimes(3)
  expect(store.sessions.some(row => row.id === rows[3]!.id)).toBe(true)
})

it('delivers the completed attachment when publication won a cancellation race', async () => {
  const store = useContentUploadsStore(24)
  const landed = vi.fn()
  state.run.mockRejectedValueOnce(new Error('response lost'))
  await store.start([{ file: new File(['abc'], 'a.txt'), file_name: 'a.txt', on_landed: landed }])
  await vi.waitFor(() => expect(store.active.size).toBe(0))
  state.api.cancel_upload_session.mockResolvedValue({ ... session, status: 'completed' })
  await store.cancel(session.id)
  expect(landed).toHaveBeenCalledOnce()
  expect(store.sessions).toEqual([])
})

it.each([
  { status: 409, code: 'UPLOAD_SESSION_EXPIRED' },
  { status: 404 },
  { status: 403 },
])('releases unavailable session resources after a missing-list lookup: %j', async (failure) => {
  const store = useContentUploadsStore(24)
  state.run.mockImplementation(() => new Promise(() => {}))
  const on_landed = vi.fn()
  await store.start([{ file: new File(['abc'], 'a.txt'), file_name: 'a.txt', on_landed }])
  state.api.get_upload_session.mockRejectedValueOnce(Object.assign(new Error('unavailable'), failure))
  store.apply_list({ enabled: true, sessions: [] })
  await vi.waitFor(() => expect(store.sessions).toEqual([]))
  expect(store.has_file(session.id)).toBe(false)
  expect(store.active.size).toBe(0)
  expect(state.pause).toHaveBeenCalled()
  expect(on_landed).not.toHaveBeenCalled()
  expect(state.api.cancel_upload_session).not.toHaveBeenCalled()
})

it.each([{ status: 409 }, { status: 503 }, {}])('retains an uncertain session and exposes lookup failure: %j', async (failure) => {
  const store = useContentUploadsStore(24)
  store.apply_list({ enabled: true, sessions: [session] })
  state.api.get_upload_session.mockRejectedValueOnce(Object.assign(new Error('查询暂不可用'), failure))
  store.apply_list({ enabled: true, sessions: [] })
  await vi.waitFor(() => expect(store.errors.get(session.id)).toBe('查询暂不可用'))
  expect(store.sessions).toHaveLength(1)
})

it('clears local uploads on identity or grant change after the creating component has unmounted', async () => {
  const component = effectScope()
  const store = component.run(() => useContentUploadsStore(24))!
  let finish!: (value: ContentUploadSession) => void
  state.run.mockImplementation(() => new Promise<ContentUploadSession>((resolve) => {
    finish = resolve
  }))
  const on_landed = vi.fn()
  await store.start([{ file: new File(['abc'], 'a.txt'), file_name: 'a.txt', on_landed }])
  component.stop()
  expect(state.pause).not.toHaveBeenCalled()
  user.value = { id: 8, is_admin: true }
  expect(store.sessions).toEqual([])
  expect(store.has_file(session.id)).toBe(false)
  expect(state.pause).toHaveBeenCalledOnce()
  finish(session)
  await Promise.resolve()
  expect(on_landed).not.toHaveBeenCalled()
  expect(state.api.adopt_upload_session).not.toHaveBeenCalled()
  store.apply_list({ enabled: true, sessions: [session] })
  user.value = { id: 8, is_admin: false }
  expect(store.sessions).toEqual([])
  expect(state.api.cancel_upload_session).not.toHaveBeenCalled()
})

it('persists the source handle under the actor, scope and accepted session rather than the resolved name', async () => {
  const store = useContentUploadsStore(24)
  const file = new File(['abc'], 'original.txt')
  const handle = { getFile: vi.fn().mockResolvedValue(file) } as unknown as FileSystemFileHandle
  state.run.mockRejectedValueOnce(new Error('offline'))
  await store.start([{ file, file_name: 'folder/renamed.txt', handle }])
  expect(state.save_handle).toHaveBeenCalledWith(expect.any(String), `7:24:session:${session.id}`, { file_name: 'original.txt', file_size: 3, handle })
  await vi.waitFor(() => expect(store.active.size).toBe(0))
  await store.cancel(session.id)
  await vi.waitFor(() => expect(state.delete_handle).toHaveBeenCalledWith(expect.any(String), `7:24:session:${session.id}`))
})

it('resumes from a persisted handle after refresh without asking for a replacement File', async () => {
  const file = new File(['abc'], 'original.txt')
  const handle = { queryPermission: vi.fn().mockResolvedValue('granted'), getFile: vi.fn().mockResolvedValue(file) }
  state.load_handle.mockResolvedValue({ file_name: file.name, file_size: file.size, handle })
  const store = useContentUploadsStore(24)
  store.apply_list({ enabled: true, sessions: [{ ... session, status: 'uploading' }] })
  await expect(store.resume(session.id)).resolves.toBe(true)
  expect(state.load_handle).toHaveBeenCalledWith(expect.any(String), `7:24:session:${session.id}`)
  expect(state.run).toHaveBeenCalledWith(file)
  expect(store.sessions).toEqual([])
})

it('uses the existing file picker fallback when a handle cannot be recovered', async () => {
  state.load_handle.mockRejectedValueOnce(new Error('IndexedDB unavailable'))
  const store = useContentUploadsStore(24)
  store.apply_list({ enabled: true, sessions: [{ ... session, status: 'uploading' }] })
  await expect(store.resume(session.id)).resolves.toBe(false)
  expect(state.run).not.toHaveBeenCalled()
  expect(state.api.adopt_upload_session).not.toHaveBeenCalled()
  expect(store.active.size).toBe(0)
})

it('does not read a revoked handle or prompt for permission during recovery', async () => {
  const handle = { queryPermission: vi.fn().mockResolvedValue('denied'), getFile: vi.fn(), requestPermission: vi.fn() }
  state.load_handle.mockResolvedValue({ file_name: 'a.txt', file_size: 3, handle })
  const store = useContentUploadsStore(24)
  store.apply_list({ enabled: true, sessions: [{ ... session, status: 'uploading' }] })
  await expect(store.resume(session.id)).resolves.toBe(false)
  expect(handle.getFile).not.toHaveBeenCalled()
  expect(handle.requestPermission).not.toHaveBeenCalled()
  expect(state.run).not.toHaveBeenCalled()
})

it('discards a late recovered file after account change and never shares the old handle key', async () => {
  let loaded!: (value: unknown) => void
  state.load_handle.mockImplementationOnce(() => new Promise((resolve) => {
    loaded = resolve
  }))
  const handle = { queryPermission: vi.fn().mockResolvedValue('granted'), getFile: vi.fn() }
  const store = useContentUploadsStore(24)
  store.apply_list({ enabled: true, sessions: [{ ... session, status: 'uploading' }] })
  const pending = store.resume(session.id)
  user.value = { id: 8, is_admin: true }
  loaded({ file_name: 'a.txt', file_size: 3, handle })
  await pending
  expect(handle.getFile).not.toHaveBeenCalled()
  expect(store.has_file(session.id)).toBe(false)
  expect(state.run).not.toHaveBeenCalled()
  store.apply_list({ enabled: true, sessions: [{ ... session, status: 'uploading' }] })
  await store.resume(session.id)
  expect(state.load_handle.mock.calls.at(- 1)?.[1]).toBe(`8:24:session:${session.id}`)
})

it('rejects a list captured before identity reset even if it arrives after the next list', () => {
  const store = useContentUploadsStore(24)
  const epoch = store.snapshot_epoch()
  user.value = { id: 8, is_admin: true }
  const next = { ... session, id: 'b'.repeat(32) }
  store.apply_list({ enabled: true, sessions: [next] })
  store.apply_list({ enabled: true, sessions: [session] }, epoch)
  expect(store.sessions).toEqual([next])
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

// Exercise the real store -> admission -> runtime wiring. Only hashing, API
// and browser persistence are replaced, so an omitted identity reset is caught.
it('aborts hashing on identity change and fences old progress and completion from the next selection', async () => {
  const store = useContentUploadsStore(24)
  const old_hash = deferred<string>()
  const new_hash = deferred<string>()
  state.hash.mockReturnValueOnce(old_hash.promise).mockReturnValueOnce(new_hash.promise)
  const old_start = store.start([{ file: new File(['abc'], 'old.txt'), file_name: 'old.txt' }])
  const [, signal, progress] = state.hash.mock.calls[0]!
  user.value = { id: 8, is_admin: true }
  expect(signal.aborted).toBe(true)
  const new_start = store.start([{ file: new File(['abc'], 'new.txt'), file_name: 'new.txt' }])
  progress({ loaded: 2, total: 3 })
  old_hash.resolve(session.sha256)
  await old_start
  expect(store.preparing).toEqual({ path: 'new.txt', loaded: 0, total: 3 })
  expect(state.api.begin_upload_batch).not.toHaveBeenCalled()
  await expect(store.start([])).rejects.toThrow('正在处理所选文件')
  new_hash.resolve(session.sha256)
  await new_start
  expect(state.api.begin_upload_batch).toHaveBeenCalledOnce()
  expect(state.api.begin_upload_batch.mock.calls[0]![0].entries[0].path).toBe('new.txt')
  await vi.waitFor(() => expect(store.active.size).toBe(0))
})

it.each(['success', 'failure'])('discards a late admission %s without changing the next identity batch', async (outcome) => {
  const store = useContentUploadsStore(24)
  const old_request = deferred<unknown>()
  const new_request = deferred<unknown>()
  state.api.begin_upload_batch.mockReturnValueOnce(old_request.promise).mockReturnValueOnce(new_request.promise)
  const on_landed = vi.fn()
  const old_start = store.start([{ file: new File(['abc'], 'old.txt'), file_name: 'old.txt', on_landed }])
  await vi.waitFor(() => expect(store.admitting).toBe(true))
  user.value = { id: 8, is_admin: true }
  const new_start = store.start([{ file: new File(['abc'], 'new.txt'), file_name: 'new.txt' }])
  await vi.waitFor(() => expect(state.api.begin_upload_batch).toHaveBeenCalledTimes(2))
  if (outcome === 'success')
    old_request.resolve({ accepted: [{ index: 0, session_id: session.id }], sessions: [session], skipped: [], renamed: [] })
  else
    old_request.reject({ code: 'BATCH_REJECTED', details: { items: [], valid_count: 0 } })
  await old_start
  expect(store.admitting).toBe(true)
  expect(store.resolution).toBeNull()
  expect(store.admission_error).toBe('')
  expect(store.sessions).toEqual([])
  expect(state.run).not.toHaveBeenCalled()
  expect(on_landed).not.toHaveBeenCalled()
  new_request.resolve({ accepted: [], sessions: [], skipped: [], renamed: [] })
  await new_start
  expect(store.admitting).toBe(false)
})

it('attaches the whole accepted batch before bytes and maps renamed entries by selection index', async () => {
  const store = useContentUploadsStore(24)
  const saved = deferred<void>()
  const first = new File(['abc'], 'first.txt')
  const second = new File(['def'], 'second.txt')
  const handle = {} as FileSystemFileHandle
  const rows = [{ ... session, status: 'queued', path: 'renamed.txt' }, { ... session, id: 'b'.repeat(32), status: 'queued', path: 'first.txt' }]
  state.api.begin_upload_batch.mockResolvedValueOnce({
    accepted: [{ index: 1, session_id: rows[0]!.id }, { index: 0, session_id: rows[1]!.id }],
    sessions: rows, skipped: [], renamed: [{ from: 'second.txt', to: 'renamed.txt' }],
  })
  state.save_handle.mockResolvedValueOnce(undefined).mockReturnValueOnce(saved.promise)
  state.run.mockRejectedValue(new Error('offline'))
  const pending = store.start([{ file: first, file_name: 'first.txt', handle }, { file: second, file_name: 'second.txt', handle }])
  await vi.waitFor(() => expect(state.save_handle).toHaveBeenCalledTimes(2))
  expect(state.run).not.toHaveBeenCalled()
  expect(store.queued.size).toBe(2)
  expect(state.save_handle.mock.calls[0]![2].file_name).toBe('second.txt')
  expect(state.save_handle.mock.calls[1]![2].file_name).toBe('first.txt')
  saved.resolve()
  await pending
  await vi.waitFor(() => expect(state.run).toHaveBeenCalledTimes(2))
  expect(state.run.mock.calls.map(call => call[0])).toEqual([second, first])
  await vi.waitFor(() => expect(store.active.size).toBe(0))
})

it('does not attach the rest of a batch after identity changes during handle persistence', async () => {
  const store = useContentUploadsStore(24)
  const saved = deferred<void>()
  const rows = [session, { ... session, id: 'b'.repeat(32) }]
  state.api.begin_upload_batch.mockResolvedValueOnce({ accepted: rows.map((row, index) => ({ index, session_id: row.id })), sessions: rows, skipped: [], renamed: [] })
  state.save_handle.mockReturnValueOnce(saved.promise)
  const pending = store.start(rows.map((row, index) => ({ file: new File(['abc'], `${index}.txt`), file_name: row.path, handle: {} as FileSystemFileHandle })))
  await vi.waitFor(() => expect(state.save_handle).toHaveBeenCalledOnce())
  user.value = { id: 8, is_admin: true }
  saved.resolve()
  await pending
  expect(state.save_handle).toHaveBeenCalledOnce()
  expect(state.run).not.toHaveBeenCalled()
  expect(store.sessions).toEqual([])
  expect(store.queued.size).toBe(0)
  expect(store.has_file(rows[1]!.id)).toBe(false)
})

it('only dismisses a rejected selection, retaining unknown admission for an idempotent retry', async () => {
  const store = useContentUploadsStore(24)
  const entries = [{ file: new File(['abc'], 'a.txt'), file_name: 'a.txt' }]
  state.api.begin_upload_batch.mockRejectedValueOnce(new Error('network'))
  await store.start(entries)
  const request_id = state.api.begin_upload_batch.mock.calls[0]![0].request_id
  store.dismiss_resolution()
  await expect(store.start(entries)).rejects.toThrow('请先处理上一批上传的受理结果')
  state.api.begin_upload_batch.mockRejectedValueOnce({ code: 'BATCH_REJECTED', details: { items: [], valid_count: 0 } })
  await store.submit()
  expect(state.api.begin_upload_batch.mock.calls[1]![0].request_id).toBe(request_id)
  store.dismiss_resolution()
  expect(store.resolution).toBeNull()
  await store.submit()
  expect(state.api.begin_upload_batch).toHaveBeenCalledTimes(2)
  await store.start(entries)
  expect(state.api.begin_upload_batch.mock.calls[2]![0].request_id).not.toBe(request_id)
  await vi.waitFor(() => expect(store.active.size).toBe(0))
})
