import type { ContentAttachmentWorkspace, ContentWorkspaceCommandResult, ContentWorkspaceNode } from '@shared/types/content'
import type { ContentUploadReservation, ContentUploadSession } from '@shared/types/content-upload'
import type { UploadPreparation } from '../uploads/admission'
import type { WorkspaceListRow } from './workspace-model'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { computed, effectScope, onScopeDispose, reactive, ref, watch } from 'vue'
import { accept_attachment_snapshot } from './model'

const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
  toast: vi.fn(),
  info: vi.fn(),
  uploads: {} as { sessions: ContentUploadSession[], preparations: UploadPreparation[], reservations: ContentUploadReservation[], identity_key: string, admission_error: string, admitting: boolean, start: ReturnType<typeof vi.fn> },
  workspace: vi.fn(),
  sync: vi.fn(),
}))
vi.mock('../uploads/store', () => ({ useContentUploadsStore: () => mocks.uploads }))
vi.mock('../uploads/sync', () => ({ useContentUploadSync: (... args: unknown[]) => mocks.sync(... args) }))
vi.mock('./workspace', () => ({ createAttachmentWorkspace: (... args: unknown[]) => mocks.workspace(... args) }))
const { useAttachmentPanel } = await import('./panel')
let scope: ReturnType<typeof effectScope>
const action = { operation: 'delete' as const, targets: [{ id: 3, version: 'v1' }] }
const nodes: ContentWorkspaceNode[] = [
  { id: 2, parent_id: 1, name: 'docs', path: 'docs', kind: 'folder', version: 'v1' },
  { id: 3, parent_id: 2, name: 'qa.txt', path: 'docs/qa.txt', kind: 'file', version: 'v1' },
  { id: 4, parent_id: 2, name: 'other.txt', path: 'docs/other.txt', kind: 'file', version: 'v1' },
]
const workspace: ContentAttachmentWorkspace = { nodes, root_id: 1, attachments: [], folders: ['docs'], namespace_revision: 1, viewer_key: '7:true' }
const success: ContentWorkspaceCommandResult = { succeeded: ['qa.txt'], skipped: [], renamed: [], workspace }
const interaction = { open_url: vi.fn(), save_url: vi.fn() }

beforeEach(() => {
  vi.resetAllMocks()
  mocks.uploads = reactive({ sessions: [], preparations: [], reservations: [], identity_key: '7:25', admission_error: '', admitting: false, start: vi.fn() })
  scope = effectScope()
  for (const [name, value] of Object.entries({ computed, ref, watch }))
    vi.stubGlobal(name, value)
  vi.stubGlobal('onMounted', vi.fn())
  vi.stubGlobal('onUnmounted', onScopeDispose)
  vi.stubGlobal('useApi', () => ({ content: { execute_workspace_command: mocks.execute } }))
  vi.stubGlobal('useAuth', () => ({ user: ref({ id: 7, is_admin: true }) }))
  vi.stubGlobal('useMyToast', () => ({ error: mocks.toast, info: mocks.info }))
  mocks.workspace.mockImplementation(() => {
    const data = ref(workspace)
    return { data, ready: Promise.resolve(), accept: (incoming: ContentAttachmentWorkspace) => {
      data.value = accept_attachment_snapshot(data.value, incoming)
    } }
  })
  mocks.sync.mockResolvedValue(undefined)
  mocks.execute.mockResolvedValue(success)
})
afterEach(() => {
  scope.stop()
  vi.unstubAllGlobals()
})
const mount = () => scope.run(() => useAttachmentPanel({ scope: 25, markdown: () => '', interaction }))!

it('shows inherited privacy only once the server confirms removal of a declaration', async () => {
  const panel = await mount()
  mocks.execute.mockResolvedValueOnce({ ... success, still_inherited_private: ['docs.good/qa.txt'] })
  const input = { operation: 'set_private' as const, targets: action.targets, private: false }
  const pending = panel.execute(input)
  expect(mocks.info).not.toHaveBeenCalled()
  await pending
  expect(mocks.info).toHaveBeenCalledExactlyOnceWith('已移除自身机密标记，1 项仍因上级文件夹保持机密')
  await panel.execute(input)
  expect(mocks.info).toHaveBeenCalledTimes(1)
})

it('recomputes direct and indirect references from local Markdown, independently of the pending-delete check', () => {
  const source = ref<{ markdown: string } | null>({ markdown: '---\ncover: docs/cover.png\n---\n\n[](att://docs/qa.txt.good)' })
  const panel = scope.run(() => useAttachmentPanel({ scope: 25, markdown: () => '', reference_source: () => source.value, interaction }))!
  const files = ['docs/cover.png', 'docs/qa.txt', 'docs/qa.txt.good'].map(file_name => ({ file_name, mime_type: 'text/plain', is_image: file_name.endsWith('.png'), file_size: 1, version: 'v1', url: '/file', has_redacted: file_name.endsWith('.good') }))
  panel.catalog.accept({ ... workspace, attachments: files })
  expect(panel.referenced_paths.value).toEqual(new Set(['docs', 'docs/cover.png', 'docs/qa.txt', 'docs/qa.txt.good']))
  source.value = { markdown: '---\ncover: docs/cover.png\n---' }
  expect(panel.referenced_paths.value).toEqual(new Set(['docs', 'docs/cover.png']))
  source.value = null
  expect(panel.referenced_paths.value).toBeNull()
})

it('keeps uncertain commands after closing their dialog and retries the same receipt', async () => {
  const panel = await mount()
  panel.expanded.value.add(2)
  mocks.execute.mockRejectedValueOnce(new Error('连接中断')).mockRejectedValueOnce(new Error('连接中断'))
  await panel.execute(action)
  expect(panel.failure_visible.value).toBe(true)
  const row = panel.rows.value.find(row => row.node?.id === 3)!
  expect(panel.command_failed(row)).toBe(true)
  panel.failure_visible.value = false
  expect(panel.request_error.value).toBe('附件操作结果待确认')
  expect(panel.capabilities(row).delete).toBe(false)
  await panel.execute(action)
  expect(panel.failure_visible.value).toBe(true)
  expect(mocks.execute).toHaveBeenCalledTimes(1)
  panel.failure_visible.value = false
  await panel.submit()
  expect(panel.failure_visible.value).toBe(true)
  expect(mocks.execute.mock.calls[1]![0]).toEqual(mocks.execute.mock.calls[0]![0])
  await panel.submit()
  expect(panel.failure_visible.value).toBe(false)
  expect(panel.request_error.value).toBe('')
})

it('reopens unresolved upload errors on another selection and closes after reconciliation or identity reset', async () => {
  const panel = await mount()
  mocks.uploads.admission_error = '请求参数不合法！'
  expect(panel.failure_visible.value).toBe(true)
  panel.failure_visible.value = false
  mocks.uploads.start.mockRejectedValueOnce(new Error('请先处理上一批上传的受理结果'))
  await panel.start([{ file: new File(['test'], 'test.txt'), file_name: 'test.txt' }])
  expect(panel.failure_visible.value).toBe(true)
  expect(mocks.toast).not.toHaveBeenCalled()
  mocks.uploads.admitting = true
  mocks.uploads.admission_error = ''
  expect(panel.failure_visible.value).toBe(true)
  mocks.uploads.admitting = false
  expect(panel.failure_visible.value).toBe(false)
  mocks.uploads.admission_error = '新的错误'
  expect(panel.failure_visible.value).toBe(true)
  mocks.uploads.identity_key = '8:25'
  expect(panel.failure_visible.value).toBe(false)
})

it('opens the dialog for another failed command even when its message matches the first unresolved error', async () => {
  const panel = await mount()
  mocks.execute.mockRejectedValue(new Error('请求参数不合法！'))
  await panel.execute(action)
  panel.failure_visible.value = false
  await panel.execute({ operation: 'rename', target: { id: 4, version: 'v1' }, name: 'next.txt' })
  expect(mocks.execute).toHaveBeenCalledTimes(2)
  expect(panel.failure_visible.value).toBe(true)
})

it.each(['delete', 'rename'] as const)('applies the committed %s snapshot before ending pending without waiting for notifications', async (operation) => {
  let finish!: (value: typeof success) => void
  mocks.execute.mockImplementationOnce(() => new Promise((resolve) => {
    finish = resolve
  }))
  const panel = await mount()
  panel.expanded.value.add(2)
  const completed = panel.execute(operation === 'delete' ? action : { operation, target: { id: 3, version: 'v1' }, name: 'next.txt' })
  expect(panel.pending.value).toBe(true)
  if (operation === 'delete')
    expect(panel.rows.value.some(row => row.name === 'qa.txt')).toBe(true)
  else
    expect(panel.rows.value.find(row => row.node?.id === 3)).toMatchObject({ name: 'next.txt', path: 'docs/next.txt' })
  const next_nodes = operation === 'delete' ? nodes.filter(node => node.id !== 3) : nodes.map(node => node.id === 3 ? { ... node, name: 'next.txt', path: 'docs/next.txt', version: 'v2' } : node)
  const states: string[][] = []
  watch(panel.pending, (pending) => {
    if (! pending)
      states.push(panel.rows.value.map(row => row.name))
  }, { flush: 'sync' })
  finish({ ... success, workspace: { ... workspace, nodes: next_nodes, namespace_revision: 2 } })
  await completed
  expect(states).toHaveLength(1)
  expect(states[0]).not.toContain('qa.txt')
  if (operation === 'rename')
    expect(states[0]).toContain('next.txt')
  expect(panel.catalog.data.value?.namespace_revision).toBe(2)
  // A delayed pre-command invalidation fetch cannot put the old row back.
  panel.catalog.accept(workspace)
  expect(panel.catalog.data.value?.namespace_revision).toBe(2)
})

it('expands the target folder and its ancestors for local and admitted upload rows', async () => {
  const panel = await mount()
  panel.catalog.accept({ ... workspace, nodes: [... nodes, { id: 5, parent_id: 2, name: 'sub', path: 'docs/sub', kind: 'folder', version: 'v1' }] })
  const preparation: UploadPreparation = { id: 'local', path: 'docs/sub/new.txt', size: 10, loaded: 0, phase: 'admitting' }
  mocks.uploads.preparations = [preparation]
  expect([... panel.expanded.value].sort((a, b) => a - b)).toEqual([2, 5])
  expect(panel.rows.value.find(row => row.key === 'preparing:local')).toMatchObject({ parent_id: 5, name: 'new.txt', depth: 2 })

  const session = { id: 'accepted', parent_id: 5, path: 'docs/sub/confirmed.txt', status: 'uploading' } as ContentUploadSession
  mocks.uploads.preparations = [{ ... preparation, session_id: session.id }]
  mocks.uploads.sessions = [session]
  expect(panel.rows.value.filter(row => row.preparation || row.session).map(row => row.key)).toEqual(['session:accepted'])
  expect(panel.rows.value.find(row => row.key === 'session:accepted')).toMatchObject({ parent_id: 5, name: 'confirmed.txt', depth: 2 })

  const missing: UploadPreparation = { id: 'nested', path: 'docs/unsynced/deep/new.txt', size: 10, loaded: 0, phase: 'waiting' }
  mocks.uploads.preparations = [missing]
  mocks.uploads.sessions = []
  expect([... panel.expanded.value].sort((a, b) => a - b)).toEqual([2, 5])
  expect(panel.rows.value.map(row => [row.key, row.depth])).toEqual([
    ['node:2', 0],
    ['node:5', 1],
    ['pending-folder:docs/unsynced', 1],
    ['pending-folder:docs/unsynced/deep', 2],
    ['preparing:nested', 3],
    ['node:4', 1],
    ['node:3', 1],
  ])
})

it('keeps an optimistic rename visible with a result-pending marker after a lost receipt, then adopts the server result', async () => {
  const confirmed = nodes.map(node => node.id === 3 ? { ... node, name: 'server.txt', path: 'docs/server.txt', version: 'v2' } : node)
  mocks.execute.mockRejectedValueOnce(new Error('连接中断')).mockResolvedValueOnce({ ... success, workspace: { ... workspace, nodes: confirmed, namespace_revision: 2 } })
  const panel = await mount()
  panel.expanded.value.add(2)
  await panel.execute({ operation: 'rename', target: { id: 3, version: 'v1' }, name: 'next.txt' })
  const row = panel.rows.value.find(row => row.node?.id === 3)!
  expect(row).toMatchObject({ name: 'next.txt', path: 'docs/next.txt' })
  expect(panel.command_pending(row)).toBe(false)
  expect(panel.command_failed(row)).toBe(true)

  await panel.submit()
  expect(panel.rows.value.find(row => row.node?.id === 3)).toMatchObject({ name: 'server.txt', path: 'docs/server.txt' })
  expect(panel.command_failed(panel.rows.value.find(row => row.node?.id === 3)!)).toBe(false)
})

it('restores the original rename immediately when the server explicitly rejects it', async () => {
  const details = { items: [{ item: 3, target: 'docs/qa.txt', category: 'name_conflict', code: 'NAME_TAKEN', reason: '已占用', allowed: ['fail'] }], valid_count: 0 }
  mocks.execute.mockRejectedValueOnce(Object.assign(new Error('整批未执行'), { code: 'BATCH_REJECTED', details }))
  const panel = await mount()
  panel.expanded.value.add(2)
  await panel.execute({ operation: 'rename', target: { id: 3, version: 'v1' }, name: 'next.txt' })
  expect(panel.resolution.value).toEqual(details)
  expect(panel.rows.value.find(row => row.node?.id === 3)).toMatchObject({ name: 'qa.txt', path: 'docs/qa.txt' })
})

it('restores the original rename and releases its fence after another explicit client rejection', async () => {
  mocks.execute.mockRejectedValueOnce(Object.assign(new Error('请求参数不合法！'), { data: { httpStatus: 400 } }))
  const panel = await mount()
  panel.expanded.value.add(2)
  const command = { operation: 'rename' as const, target: { id: 3, version: 'v1' }, name: 'next.txt' }
  await panel.execute(command)
  const row = panel.rows.value.find(row => row.node?.id === 3)!
  expect(row).toMatchObject({ name: 'qa.txt', path: 'docs/qa.txt' })
  expect(panel.command_failed(row)).toBe(false)
  expect(panel.request_error.value).toBe('')
  expect(panel.can_execute(command)).toBe(true)
  expect(mocks.toast).toHaveBeenCalledExactlyOnceWith('请求参数不合法！')
})

it('moves a row to its expected parent before the receipt arrives', async () => {
  let finish!: (value: typeof success) => void
  mocks.execute.mockImplementationOnce(() => new Promise((resolve) => {
    finish = resolve
  }))
  const panel = await mount()
  panel.expanded.value.add(2)
  const pending = panel.execute({ operation: 'move', targets: [{ id: 3, version: 'v1' }], parent_id: 1 })
  expect(panel.rows.value.find(row => row.node?.id === 3)).toMatchObject({ parent_id: 1, path: 'qa.txt', depth: 0 })
  finish({ ... success, workspace: { ... workspace, nodes: nodes.map(node => node.id === 3 ? { ... node, parent_id: 1, path: 'qa.txt', version: 'v2' } : node), namespace_revision: 2 } })
  await pending
  expect(panel.rows.value.find(row => row.node?.id === 3)).toMatchObject({ parent_id: 1, path: 'qa.txt', depth: 0 })
})

it('previews and downloads only the redacted pixels for a guest of a private owner', async () => {
  const sign = vi.fn().mockResolvedValue({ url: '/signed-redacted-download' })
  vi.stubGlobal('useApi', () => ({ content: { execute_workspace_command: mocks.execute, sign_attachment_download: sign } }))
  vi.stubGlobal('useAuth', () => ({ user: ref(null) }))
  const attachment = { id: 3, file_name: 'photo.png.good', mime_type: 'image/webp', file_size: 20, version: 'v1',
    url: null, is_image: true, is_private: true, has_redacted: true, is_redacted_view: true, redacted_url: '/read?role=redacted' }
  const panel = await mount()
  const row = { key: 'node:3', parent_id: 1, depth: 0, name: attachment.file_name, path: attachment.file_name,
    node: { id: 3, parent_id: 1, name: attachment.file_name, path: attachment.file_name, kind: 'file' as const, version: 'v1', attachment } }
  panel.preview(row)
  expect(panel.preview_visible.value).toBe(false)
  expect(panel.preview_images.value).toEqual([])
  panel.open(row)
  expect(panel.preview_images.value).toEqual(['/read?role=redacted'])
  expect(panel.preview_visible.value).toBe(true)
  await panel.download(row, 'redacted_display')
  await panel.download(row)
  await panel.download(row, 'original')
  expect(sign.mock.calls).toEqual([[25, attachment.file_name, 'redacted_display']])
  expect(interaction.save_url).toHaveBeenCalledOnce()
  expect(interaction.save_url).toHaveBeenCalledWith('/signed-redacted-download')
  expect(mocks.toast).not.toHaveBeenCalled()
  expect(mocks.info).not.toHaveBeenCalled()
})

it('opens browser media directly and downloads other files through signed URLs', async () => {
  const sign = vi.fn().mockResolvedValue({ url: '/signed-download' })
  vi.stubGlobal('useApi', () => ({ content: { execute_workspace_command: mocks.execute, sign_attachment_download: sign } }))
  vi.stubGlobal('useAuth', () => ({ user: ref(null) }))
  const panel = await mount()
  const row = (name: string, mime_type: string): WorkspaceListRow => ({
    key: `node:${name}`, parent_id: 1, depth: 0, name, path: name,
    node: { id: 3, parent_id: 1, name, path: name, kind: 'file', version: 'v1', attachment: {
      id: 3, file_name: name, mime_type, file_size: 20, version: 'v1', is_image: false, url: `/${name}`,
    } },
  })

  panel.open(row('audio.mp3', 'audio/mpeg'))
  expect(interaction.open_url).toHaveBeenCalledExactlyOnceWith('/audio.mp3')
  expect(sign).not.toHaveBeenCalled()

  const private_audio = row('audio.mp3.good', 'audio/mpeg')
  Object.assign(private_audio.node!.attachment!, { url: null, is_private: true, has_redacted: true, is_redacted_view: true, redacted_url: '/audio.mp3' })
  panel.open(private_audio)
  expect(interaction.open_url).toHaveBeenCalledOnce()
  expect(sign).not.toHaveBeenCalled()
  expect(mocks.info).toHaveBeenCalledExactlyOnceWith('无权打开此机密附件！')

  const private_video = row('video.mp4.good', 'video/mp4')
  Object.assign(private_video.node!.attachment!, { is_private: true })
  panel.open(private_video)
  expect(interaction.open_url).toHaveBeenCalledOnce()
  expect(sign).not.toHaveBeenCalled()
  expect(mocks.info).toHaveBeenCalledTimes(2)
  expect(mocks.info).toHaveBeenLastCalledWith('无权打开此机密附件！')

  panel.open(row('notes.txt', 'text/plain'))
  await vi.waitFor(() => expect(interaction.save_url).toHaveBeenCalledExactlyOnceWith('/signed-download'))
  expect(sign).toHaveBeenCalledExactlyOnceWith(25, 'notes.txt', 'display')
  expect(interaction.open_url).toHaveBeenCalledOnce()
  expect(mocks.toast).not.toHaveBeenCalled()
})

it.each([true, false])('downloads the explicitly selected normal, archive, or redacted image without role fallback (private: %s)', async (is_private) => {
  const sign = vi.fn().mockResolvedValue({ url: '/download' })
  vi.stubGlobal('useApi', () => ({ content: { execute_workspace_command: mocks.execute, sign_attachment_download: sign } }))
  if (! is_private)
    vi.stubGlobal('useAuth', () => ({ user: ref(null) }))
  const panel = await mount()
  const row: WorkspaceListRow = { key: 'node:3', parent_id: 1, depth: 0, name: 'photo.png', path: 'photo.png', node: {
    id: 3, parent_id: 1, name: 'photo.png', path: 'photo.png', kind: 'file', version: 'v1', attachment: {
      id: 3, file_name: 'photo.png', mime_type: 'image/webp', file_size: 20, version: 'v1', is_image: true,
      is_private, url: '/normal', has_redacted: true, redacted_url: '/redacted',
    },
  } }
  await panel.download(row)
  await panel.download(row, 'original')
  await panel.download(row, 'redacted_display')
  expect(sign.mock.calls).toEqual([[25, row.path, 'display'], [25, row.path, 'original'], [25, row.path, 'redacted_display']])
  expect(interaction.save_url).toHaveBeenCalledTimes(3)
})

it.each([
  { can_private: true, private: true, normal: '/normal', redacted: '/redacted', expected: '/normal' },
  { can_private: false, private: true, normal: null, redacted: '/redacted', expected: '/redacted' },
  { can_private: false, private: true, normal: '/stale-normal', redacted: '/redacted', expected: '/redacted' },
  { can_private: false, private: true, normal: null, redacted: null, expected: null },
  { can_private: true, private: true, normal: null, redacted: '/redacted', expected: '/redacted' },
  { can_private: false, private: false, normal: '/public', redacted: '/redacted', expected: '/public' },
  { can_private: false, private: false, normal: null, redacted: null, expected: null },
])('prefers the permitted normal image, falls back to redacted, or explains why it cannot open: %j', async (scenario) => {
  vi.stubGlobal('useAuth', () => ({ user: ref(scenario.can_private ? { id: 7, is_admin: true } : { id: 8, is_admin: false, permissions: [] }) }))
  const panel = await mount()
  const row: WorkspaceListRow = { key: 'node:3', parent_id: 1, depth: 0, name: 'photo.png', path: 'photo.png', node: {
    id: 3, parent_id: 1, name: 'photo.png', path: 'photo.png', kind: 'file', version: 'v1', attachment: {
      id: 3, file_name: 'photo.png', mime_type: 'image/webp', file_size: 20, version: 'v1', is_image: true,
      is_private: scenario.private, url: scenario.normal, has_redacted: !! scenario.redacted, redacted_url: scenario.redacted,
    },
  } }
  panel.open(row)
  expect(panel.preview_visible.value).toBe(!! scenario.expected)
  expect(panel.preview_images.value).toEqual(scenario.expected ? [scenario.expected] : [])
  panel.preview_visible.value = false
  panel.preview_images.value = []
  panel.preview(row, 'redacted_display')
  expect(panel.preview_visible.value).toBe(!! scenario.redacted)
  expect(panel.preview_images.value).toEqual(scenario.redacted ? [scenario.redacted] : [])
  if (scenario.expected)
    expect(mocks.info).not.toHaveBeenCalled()
  else
    expect(mocks.info).toHaveBeenCalledExactlyOnceWith(scenario.private ? '无权打开此机密附件！' : '附件暂不可读取')
  expect(mocks.toast).not.toHaveBeenCalled()
  expect(mocks.execute).not.toHaveBeenCalled()
})

it.each(['replace', 'redact'] as const)('treats %s as an upload for selection and drops selection at both handoff boundaries', async (purpose) => {
  const panel = await mount()
  panel.expanded.value.add(2)
  panel.selected.value = new Set(['node:3', 'node:4'])
  const preparation: UploadPreparation = { id: 'local-replacement', path: 'docs/new.svg', size: 10, loaded: 0, phase: 'waiting', purpose, source_id: 3 }
  mocks.uploads.preparations = [preparation]
  expect([... panel.selected.value]).toEqual(['node:4'])
  expect(panel.rows.value.filter(row => row.node?.id === 3 || row.preparation).map(row => row.key)).toEqual(['preparing:local-replacement'])
  mocks.uploads.preparations = []
  expect(panel.rows.value.find(row => row.node?.id === 3)).toMatchObject({ key: 'node:3', path: 'docs/qa.txt' })
  panel.selected.value = new Set(['node:3', 'node:4'])
  const session = { id: 'replacement', purpose, source_id: 3, path: 'docs/new.svg', parent_id: 2, status: 'uploading' } as ContentUploadSession
  mocks.uploads.sessions = [session]
  expect([... panel.selected.value]).toEqual(['node:4'])
  const task = panel.rows.value.find(row => row.session?.id === session.id)!
  expect(task.node).toBeUndefined()
  expect(task.path).toBe('docs/new.svg')
  panel.selected.value = new Set([task.key])
  expect([... panel.selected.value]).toEqual(['session:replacement'])
  mocks.uploads.sessions = [session, { ... session, id: 'create', source_id: undefined, purpose: 'create', path: 'docs/other.svg' }]
  const created = panel.rows.value.find(row => row.session?.id === 'create')!
  panel.selected.value = new Set([task.key, created.key])
  expect([... panel.selected.value]).toEqual(['session:replacement', 'session:create'])
  mocks.uploads.sessions = []
  expect(panel.selected.value.size).toBe(0)
  expect(panel.rows.value.find(row => row.node?.id === 3)).toMatchObject({ key: 'node:3', path: 'docs/qa.txt' })
  expect(panel.rows.value.filter(row => row.node?.id === 3)).toHaveLength(1)
})

it.each([
  ['docs/原名.JPG', 'Selected.GIF', 'docs/原名.gif'],
  ['docs/原名.png', 'Selected.SVG', 'docs/原名.svg'],
  ['docs/报告.v2.pdf', 'Selected.DOCX', 'docs/报告.v2.docx'],
  ['docs/原名.JPG.good', 'Selected.GIF', 'docs/原名.gif.good'],
  ['docs.good/原名.JPG.good', 'Selected.GIF', 'docs.good/原名.gif.good'],
  ['docs/原名.JPG.good', 'Selected.GIF.good', 'docs/原名.gif.good'],
  ['docs/README', 'Selected.PDF', 'docs/README.pdf'],
  ['docs/原名.jpg', 'README', 'docs/原名'],
  ['docs/.hidden', '.env', 'docs/.hidden'],
  ['Parent.JPG/Archive.tar.gz', 'Selected.ZIP', 'Parent.JPG/Archive.tar.zip'],
])('uses the original stem and privacy marker of %s when replacing with %s', async (path, incoming, expected) => {
  const panel = await mount()
  const name = path.slice(path.lastIndexOf('/') + 1)
  const node = { id: 3, parent_id: 2, name, path, kind: 'file' as const, version: 'v1' }
  const row = { key: 'node:3', parent_id: 2, name, path, depth: 1, node }
  const file = new File(['new bytes'], incoming)
  await panel.replace(row, file, true)
  expect(mocks.uploads.start).toHaveBeenCalledExactlyOnceWith([expect.objectContaining({
    file, file_name: expected, purpose: 'replace', source: { id: 3, version: 'v1' },
  })])
  expect(file.name).toBe(incoming)
})

it('uses the complete selected name when keep-name is off, within the original folder', async () => {
  const panel = await mount()
  panel.expanded.value.add(2)
  const row = panel.rows.value.find(row => row.node?.id === 3)!
  const file = new File(['new bytes'], 'Selected.SVG')
  await panel.replace(row, file, false)
  expect(mocks.uploads.start).toHaveBeenCalledExactlyOnceWith([expect.objectContaining({
    file, file_name: 'docs/Selected.svg', purpose: 'replace', source: { id: 3, version: 'v1' },
  })])
})

it.each([
  ['photo.png.good', 'overwrite', 'photo.png.good', 'replace', 'overwrite'],
  ['vault.good/photo.png.good', 'overwrite', 'vault.good/photo.png.good', 'replace', 'overwrite'],
  ['vault.good/photo.png', 'overwrite', 'vault.good/photo.png', 'replace', 'overwrite'],
  ['photo.png', 'overwrite', 'photo.png', 'replace', 'overwrite'],
  ['vault.good/photo.png.good', 'copy', 'vault.good/new.webp', 'create', 'copy'],
  ['vault.good/photo.png.good', 'redacted', 'vault.good/photo.png', 'create', 'copy'],
] as const)('uses the target path for %s in %s mode', async (path, mode, expected, purpose, image_mode) => {
  const panel = await mount()
  const name = path.slice(path.lastIndexOf('/') + 1)
  const node = { id: 3, parent_id: 2, name, path, kind: 'file' as const, version: 'v1' }
  const file = new File(['pixels'], 'edited.png', { type: 'image/png' })
  await panel.edit_image({ key: 'node:3', parent_id: 2, name, path, depth: 1, node }, file, mode, 'new.webp', 'display')
  expect(mocks.uploads.start).toHaveBeenCalledExactlyOnceWith([expect.objectContaining({
    file, file_name: expected, purpose, source: { id: 3, version: 'v1' }, image_mode, image_input_basis: 'display',
  })])
  expect(mocks.uploads.start.mock.calls[0]![0][0].save_as_redaction).toBe(mode === 'redacted' ? true : undefined)
})

it('uses the synchronized scope reservations, not just this uploader\'s displayed sessions', async () => {
  const panel = await mount()
  panel.expanded.value.add(2)
  const row = (id: number) => panel.rows.value.find(row => row.node?.id === id)!
  mocks.uploads.reservations = [{ id: 'foreign', path: 'docs/new.txt', parent_id: 2, source_id: 3 }]
  expect(panel.capabilities(row(3)).rename).toBe(false)
  expect(panel.capabilities(row(2))).toMatchObject({ rename: true, move: true, delete: false })
  expect(panel.capabilities(row(4)).rename).toBe(true)
  mocks.uploads.reservations = []
  expect(panel.capabilities(row(3)).rename).toBe(true)
  expect(panel.capabilities(row(2)).delete).toBe(true)
})

it('fences intended destinations and related directories without blocking sibling destinations', async () => {
  let finish!: (value: typeof success) => void
  mocks.execute.mockImplementationOnce(() => new Promise((resolve) => {
    finish = resolve
  }))
  const panel = await mount()
  const first = panel.execute({ operation: 'rename', target: { id: 3, version: 'v1' }, name: 'next.txt' })
  expect(panel.can_execute({ operation: 'rename', target: { id: 4, version: 'v1' }, name: 'NEXT.txt' })).toBe(false)
  expect(panel.can_execute({ operation: 'rename', target: { id: 4, version: 'v1' }, name: 'unique.txt' })).toBe(true)
  expect(panel.can_execute({ operation: 'delete', targets: [{ id: 2, version: 'v1' }] })).toBe(false)
  await panel.execute({ operation: 'rename', target: { id: 4, version: 'v1' }, name: 'NEXT.txt' })
  expect(mocks.execute).toHaveBeenCalledOnce()
  await panel.start([{ file: new File(['x'], 'next.txt'), file_name: 'docs/next.txt' }])
  expect(mocks.uploads.start).not.toHaveBeenCalled()
  finish(success)
  await first
  expect(panel.can_execute({ operation: 'rename', target: { id: 4, version: 'v1' }, name: 'NEXT.txt' })).toBe(true)
})

it('preserves each conflict independently and retries only the displayed command with a new receipt id', async () => {
  const details = (target: string) => ({ items: [{ target, category: 'name_conflict', code: 'NAME_TAKEN', reason: '已占用', allowed: ['fail', 'suffix'] }], valid_count: 0 })
  mocks.execute.mockRejectedValueOnce(Object.assign(new Error('A conflict'), { code: 'BATCH_REJECTED', details: details('A') }))
    .mockRejectedValueOnce(Object.assign(new Error('B conflict'), { code: 'BATCH_REJECTED', details: details('B') }))
  const panel = await mount()
  await panel.execute(action)
  await panel.execute({ operation: 'rename', target: { id: 4, version: 'v1' }, name: 'next.txt' })
  const id = mocks.execute.mock.calls[0]![0].request_id
  expect(panel.resolution.value).toEqual(details('A'))
  const policy = { name_conflict: 'suffix', reserved: 'fail', invalid_name: 'fail', source_busy: 'fail', other: 'fail', redacted: 'fail' } as const
  await panel.submit(policy)
  expect(mocks.execute.mock.calls[2]![0]).toMatchObject({ ... action, on_error: policy })
  expect(mocks.execute.mock.calls[2]![0].request_id).not.toBe(id)
  expect(panel.resolution.value).toEqual(details('B'))
  panel.dismiss_resolution()
  expect(panel.resolution.value).toBeNull()
})

it('discards all old identity command responses, errors and busy fences', async () => {
  let finish!: (value: typeof success) => void
  mocks.execute.mockImplementationOnce(() => new Promise((resolve) => {
    finish = resolve
  }))
  const panel = await mount()
  const first = panel.execute(action)
  mocks.uploads.identity_key = '8:25'
  expect(panel.pending.value).toBe(false)
  await panel.execute(action)
  finish({ ... success, workspace: { ... workspace, namespace_revision: 99 }, renamed: [{ target: 'old', from: 'old', to: 'next', via: 'suffix' }] })
  await first
  expect(panel.request_error.value).toBe('')
  expect(panel.catalog.data.value?.namespace_revision).toBe(1)
})

it('retries a lost conflict resubmission with the same receipt instead of offering another new command', async () => {
  const details = { items: [{ target: 'qa.txt', category: 'name_conflict', code: 'NAME_TAKEN', reason: '已占用', allowed: ['fail', 'suffix'] }], valid_count: 0 }
  mocks.execute.mockRejectedValueOnce(Object.assign(new Error('整批未执行'), { code: 'BATCH_REJECTED', details }))
    .mockRejectedValueOnce(new Error('受理结果未知'))
  const panel = await mount()
  await panel.execute(action)
  await panel.submit({ name_conflict: 'suffix', reserved: 'fail', source_busy: 'fail', invalid_name: 'fail', other: 'fail', redacted: 'fail' })
  expect(panel.resolution.value).toBeNull()
  expect(panel.request_error.value).toBe('附件操作结果待确认')
  const retried = mocks.execute.mock.calls[1]![0]
  await panel.submit()
  expect(mocks.execute.mock.calls[2]![0]).toEqual(retried)
})

it('finishes a resolved command with renamed items and applies its workspace', async () => {
  const details = { items: [{ item: 3, target: 'qa.txt', category: 'name_conflict', code: 'NAME_TAKEN', reason: '已占用', allowed: ['fail', 'suffix'] }], valid_count: 0 }
  mocks.execute.mockRejectedValueOnce(Object.assign(new Error('整批未执行'), { code: 'BATCH_REJECTED', details }))
    .mockResolvedValueOnce({ ... success, renamed: [{ target: 'qa.txt', from: 'qa.txt', to: 'qa-1.txt', via: 'suffix' }], workspace: { ... workspace, namespace_revision: 2 } })
  const panel = await mount()
  await panel.execute(action)
  expect(panel.resolution.value).not.toBeNull()
  await panel.submit({ name_conflict: 'suffix', reserved: 'fail', source_busy: 'fail', invalid_name: 'fail', other: 'fail', redacted: 'fail' })
  expect(mocks.execute.mock.calls[1]![0].on_error).toMatchObject({ name_conflict: 'fail', by_item: { 3: { name_conflict: 'suffix' } } })
  expect(panel.resolution.value).toBeNull()
  expect(panel.catalog.data.value?.namespace_revision).toBe(2)
  expect(panel.request_error.value).toBe('')
})

it('runs unrelated commands independently and keeps selection made during a pending command', async () => {
  let finish!: (value: typeof success) => void
  mocks.execute.mockImplementationOnce(() => new Promise((resolve) => {
    finish = resolve
  }))
  const panel = await mount()
  panel.expanded.value.add(2)
  const row = (id: number) => panel.rows.value.find(row => row.node?.id === id)!
  panel.selected.value.add('node:3')
  const first = panel.execute(action)
  expect(panel.capabilities(row(3)).rename).toBe(false)
  expect(panel.capabilities(row(2)).move).toBe(false)
  expect(panel.capabilities(row(4)).rename).toBe(true)
  panel.selected.value = new Set(['node:4'])
  await panel.execute({ operation: 'rename', target: { id: 4, version: 'v1' }, name: 'next.txt' })
  expect(mocks.execute).toHaveBeenCalledTimes(2)
  expect(panel.capabilities(row(3)).rename).toBe(false)
  panel.selected.value = new Set(['node:4'])
  finish(success)
  await first
  expect([... panel.selected.value]).toEqual(['node:4'])
  expect(panel.capabilities(row(3)).rename).toBe(true)
})

it('keeps each failed request and its retry identity without disabling unrelated files', async () => {
  mocks.execute.mockRejectedValueOnce(new Error('A lost')).mockRejectedValueOnce(new Error('B lost'))
  const panel = await mount()
  panel.expanded.value.add(2)
  await panel.execute(action)
  expect(panel.capabilities(panel.rows.value.find(row => row.node?.id === 4)!).rename).toBe(true)
  await panel.execute({ operation: 'rename', target: { id: 4, version: 'v1' }, name: 'next.txt' })
  const ids = mocks.execute.mock.calls.map(([command]) => command.request_id)
  expect(panel.request_error.value).toBe('附件操作结果待确认')
  await panel.submit()
  expect(mocks.execute.mock.calls[2]![0].request_id).toBe(ids[0])
  expect(panel.request_error.value).toBe('附件操作结果待确认')
  await panel.submit()
  expect(mocks.execute.mock.calls[3]![0].request_id).toBe(ids[1])
  expect(panel.request_error.value).toBe('')
})

it('finishes a successful deletion without an error even with a legacy pending-cleanup count', async () => {
  mocks.execute.mockResolvedValue({ ... success, cleanup_pending: 2 })
  const panel = await mount()
  panel.selected.value.add('node:3')
  await panel.execute(action)
  expect(mocks.toast).not.toHaveBeenCalled()
  expect(panel.request_error.value).toBe('')
  expect(panel.pending.value).toBe(false)
  expect(panel.selected.value.size).toBe(0)
  await panel.execute(action)
  expect(mocks.execute).toHaveBeenCalledTimes(2)
})

it('retains a failed command for retry with the same request id', async () => {
  mocks.execute.mockRejectedValueOnce(new Error('连接中断'))
  const panel = await mount()
  panel.selected.value.add('node:3')
  await panel.execute(action)
  expect(panel.request_error.value).toBe('附件操作结果待确认')
  expect(panel.selected.value.has('node:3')).toBe(true)
  expect(panel.pending.value).toBe(false)
  await panel.submit()
  expect(mocks.execute.mock.calls[1]![0].request_id).toBe(mocks.execute.mock.calls[0]![0].request_id)
  expect(panel.request_error.value).toBe('')
  expect(panel.selected.value.size).toBe(0)
})

it('keeps batch rejection available for conflict resolution', async () => {
  const details = { items: [{ target: 'qa.txt', category: 'referenced', code: 'REFERENCED', reason: '仍有引用', allowed: ['skip'] }], valid_count: 0 }
  mocks.execute.mockRejectedValueOnce(Object.assign(new Error('整批未执行'), { code: 'BATCH_REJECTED', details }))
  const panel = await mount()
  await panel.execute(action)
  expect(panel.resolution.value).toEqual(details)
  expect(panel.request_error.value).toBe('')
  expect(mocks.toast).not.toHaveBeenCalled()
})
