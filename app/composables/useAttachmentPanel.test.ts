import type { ContentAttachmentWorkspace, ContentWorkspaceCommandResult, ContentWorkspaceNode } from '@shared/types/content'
import type { ContentUploadReservation, ContentUploadSession } from '@shared/types/content-upload'
import type { WorkspaceListRow } from '~/utils/content/workspace'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { computed, effectScope, onScopeDispose, reactive, ref, watch } from 'vue'
import { accept_attachment_snapshot } from '~/utils/content/attachment-snapshot'

const mocks = vi.hoisted(() => ({ execute: vi.fn(), toast: vi.fn(), uploads: {} as { sessions: ContentUploadSession[], reservations: ContentUploadReservation[], identity_key: string, start: ReturnType<typeof vi.fn> } }))
vi.mock('~/stores/contentUploads', () => ({ useContentUploadsStore: () => mocks.uploads }))
const { useAttachmentPanel } = await import('./useAttachmentPanel')
let scope: ReturnType<typeof effectScope>
const action = { operation: 'delete' as const, targets: [{ id: 3, version: 'v1' }], draft_references: [] }
const nodes: ContentWorkspaceNode[] = [
  { id: 2, parent_id: 1, name: 'docs', path: 'docs', kind: 'folder', version: 'v1' },
  { id: 3, parent_id: 2, name: 'qa.txt', path: 'docs/qa.txt', kind: 'file', version: 'v1' },
  { id: 4, parent_id: 2, name: 'other.txt', path: 'docs/other.txt', kind: 'file', version: 'v1' },
]
const workspace: ContentAttachmentWorkspace = { nodes, root_id: 1, attachments: [], folders: ['docs'], namespace_revision: 1, viewer_key: '7:true' }
const success: ContentWorkspaceCommandResult = { succeeded: ['qa.txt'], skipped: [], renamed: [], workspace }

beforeEach(() => {
  vi.resetAllMocks()
  mocks.uploads = reactive({ sessions: [], reservations: [], identity_key: '7:25', start: vi.fn() })
  scope = effectScope()
  for (const [name, value] of Object.entries({ computed, ref, watch }))
    vi.stubGlobal(name, value)
  vi.stubGlobal('onMounted', vi.fn())
  vi.stubGlobal('onUnmounted', onScopeDispose)
  vi.stubGlobal('document', { removeEventListener: vi.fn() })
  vi.stubGlobal('useApi', () => ({ content: { execute_workspace_command: mocks.execute } }))
  vi.stubGlobal('useAuth', () => ({ user: ref({ id: 7, is_admin: true }) }))
  vi.stubGlobal('useMyToast', () => ({ error: mocks.toast }))
  vi.stubGlobal('createAttachmentWorkspace', () => {
    const data = ref(workspace)
    return { data, ready: Promise.resolve(), accept: (incoming: ContentAttachmentWorkspace) => {
      data.value = accept_attachment_snapshot(data.value, incoming)
    } }
  })
  vi.stubGlobal('useContentUploadSync', () => Promise.resolve())
  mocks.execute.mockResolvedValue(success)
})
afterEach(() => {
  scope.stop()
  vi.unstubAllGlobals()
})
const mount = () => scope.run(() => useAttachmentPanel(25, () => ''))!

it.each(['delete', 'rename'] as const)('applies the committed %s snapshot before ending pending without waiting for notifications', async (operation) => {
  let finish!: (value: typeof success) => void
  mocks.execute.mockImplementationOnce(() => new Promise((resolve) => {
    finish = resolve
  }))
  const panel = await mount()
  panel.expanded.value.add(2)
  const completed = panel.execute(operation === 'delete' ? action : { operation, target: { id: 3, version: 'v1' }, name: 'next.txt' })
  expect(panel.pending.value).toBe(true)
  expect(panel.rows.value.some(row => row.name === 'qa.txt')).toBe(true)
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

it('previews and downloads only the redacted pixels for a guest of a private owner', async () => {
  const sign = vi.fn().mockResolvedValue({ url: '/signed-redacted-download' })
  const click = vi.fn()
  vi.stubGlobal('document', { createElement: () => ({ click, href: '', download: '' }), removeEventListener: vi.fn() })
  vi.stubGlobal('useApi', () => ({ content: { execute_workspace_command: mocks.execute, sign_attachment_download: sign } }))
  vi.stubGlobal('useAuth', () => ({ user: ref(null) }))
  const attachment = { id: 3, file_name: 'photo.png.good', mime_type: 'image/avif', file_size: 20, version: 'v1',
    url: null, is_image: true, is_private: true, is_encrypted: false, has_redacted: true, is_redacted_view: true, redacted_url: '/read?role=redacted' }
  const panel = await mount()
  const row = { key: 'node:3', parent_id: 1, depth: 0, name: attachment.file_name, path: attachment.file_name,
    node: { id: 3, parent_id: 1, name: attachment.file_name, path: attachment.file_name, kind: 'file' as const, version: 'v1', attachment } }
  panel.preview(row)
  expect(panel.preview_visible.value).toBe(false)
  expect(panel.preview_images.value).toEqual([])
  panel.open(row)
  expect(panel.preview_images.value).toEqual(['/read?role=redacted'])
  expect(panel.preview_visible.value).toBe(true)
  await panel.download(row, 'redacted_avif')
  await panel.download(row)
  await panel.download(row, 'original')
  expect(sign.mock.calls).toEqual([[25, attachment.file_name, 'redacted_avif']])
  expect(click).toHaveBeenCalledOnce()
  expect(mocks.toast).not.toHaveBeenCalled()
})

it.each([true, false])('downloads the explicitly selected normal, archive, or redacted image without role fallback (private: %s)', async (is_private) => {
  const sign = vi.fn().mockResolvedValue({ url: '/download' })
  const click = vi.fn()
  vi.stubGlobal('document', { createElement: () => ({ click, href: '', download: '' }), removeEventListener: vi.fn() })
  vi.stubGlobal('useApi', () => ({ content: { execute_workspace_command: mocks.execute, sign_attachment_download: sign } }))
  if (! is_private)
    vi.stubGlobal('useAuth', () => ({ user: ref(null) }))
  const panel = await mount()
  const row: WorkspaceListRow = { key: 'node:3', parent_id: 1, depth: 0, name: 'photo.png', path: 'photo.png', node: {
    id: 3, parent_id: 1, name: 'photo.png', path: 'photo.png', kind: 'file', version: 'v1', attachment: {
      id: 3, file_name: 'photo.png', mime_type: 'image/avif', file_size: 20, version: 'v1', is_image: true, is_encrypted: false,
      is_private, url: '/normal', has_redacted: true, redacted_url: '/redacted',
    },
  } }
  await panel.download(row)
  await panel.download(row, 'original')
  await panel.download(row, 'redacted_avif')
  expect(sign.mock.calls).toEqual([[25, row.path, 'avif'], [25, row.path, 'original'], [25, row.path, 'redacted_avif']])
  expect(click).toHaveBeenCalledTimes(3)
})

it.each([
  { can_private: true, private: true, normal: '/normal', redacted: '/redacted', expected: '/normal' },
  { can_private: false, private: true, normal: null, redacted: '/redacted', expected: '/redacted' },
  { can_private: false, private: true, normal: '/stale-normal', redacted: '/redacted', expected: '/redacted' },
  { can_private: false, private: true, normal: null, redacted: null, expected: null },
  { can_private: true, private: true, normal: null, redacted: '/redacted', expected: '/redacted' },
  { can_private: false, private: false, normal: '/public', redacted: '/redacted', expected: '/public' },
])('prefers the permitted normal image, falls back to redacted, and otherwise stays silent: %j', async (scenario) => {
  vi.stubGlobal('useAuth', () => ({ user: ref(scenario.can_private ? { id: 7, is_admin: true } : { id: 8, is_admin: false, permissions: [] }) }))
  const panel = await mount()
  const row: WorkspaceListRow = { key: 'node:3', parent_id: 1, depth: 0, name: 'photo.png', path: 'photo.png', node: {
    id: 3, parent_id: 1, name: 'photo.png', path: 'photo.png', kind: 'file', version: 'v1', attachment: {
      id: 3, file_name: 'photo.png', mime_type: 'image/avif', file_size: 20, version: 'v1', is_image: true, is_encrypted: false,
      is_private: scenario.private, url: scenario.normal, has_redacted: !! scenario.redacted, redacted_url: scenario.redacted,
    },
  } }
  panel.open(row)
  expect(panel.preview_visible.value).toBe(!! scenario.expected)
  expect(panel.preview_images.value).toEqual(scenario.expected ? [scenario.expected] : [])
  panel.preview_visible.value = false
  panel.preview_images.value = []
  panel.preview(row, 'redacted_avif')
  expect(panel.preview_visible.value).toBe(!! scenario.redacted)
  expect(panel.preview_images.value).toEqual(scenario.redacted ? [scenario.redacted] : [])
  expect(mocks.toast).not.toHaveBeenCalled()
  expect(mocks.execute).not.toHaveBeenCalled()
})

it.each(['replace', 'redact'] as const)('treats %s as an upload for selection and drops selection at both handoff boundaries', async (purpose) => {
  const panel = await mount()
  panel.expanded.value.add(2)
  panel.selected.value = new Set(['node:3', 'node:4'])
  const session = { id: 'replacement', purpose, source_id: 3, path: 'docs/new.svg', parent_id: 2, status: 'uploading' } as ContentUploadSession
  mocks.uploads.sessions = [session]
  expect([... panel.selected.value]).toEqual(['node:4'])
  const task = panel.rows.value.find(row => row.session?.id === session.id)!
  expect(task.node).toBeUndefined()
  expect(task.path).toBe('docs/new.svg')
  panel.select(task, { ctrlKey: true, metaKey: false, shiftKey: false } as MouseEvent)
  expect([... panel.selected.value]).toEqual(['session:replacement'])
  mocks.uploads.sessions = [session, { ... session, id: 'create', source_id: undefined, purpose: 'create', path: 'docs/other.svg' }]
  const created = panel.rows.value.find(row => row.session?.id === 'create')!
  panel.select(created, { ctrlKey: true, metaKey: false, shiftKey: false } as MouseEvent)
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
  ['docs/原名.JPG.good', 'Selected.GIF', 'docs/原名.gif'],
  ['docs/README', 'Selected.PDF', 'docs/README.pdf'],
  ['docs/原名.jpg', 'README', 'docs/原名'],
  ['docs/.hidden', '.env', 'docs/.hidden'],
  ['Parent.JPG/Archive.tar.gz', 'Selected.ZIP', 'Parent.JPG/Archive.tar.zip'],
])('keeps only the original stem of %s when replacing with %s', async (path, incoming, expected) => {
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
  expect(panel.can_execute({ operation: 'delete', targets: [{ id: 2, version: 'v1' }], draft_references: [] })).toBe(false)
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
  expect(panel.report.value).toBeNull()
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
  expect(panel.request_error.value).toBe('受理结果未知')
  const retried = mocks.execute.mock.calls[1]![0]
  await panel.submit()
  expect(mocks.execute.mock.calls[2]![0]).toEqual(retried)
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
  expect(panel.request_error.value).toBe('A lost')
  await panel.submit()
  expect(mocks.execute.mock.calls[2]![0].request_id).toBe(ids[0])
  expect(panel.request_error.value).toBe('B lost')
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
  expect(panel.report.value).toBeNull()
  await panel.execute(action)
  expect(mocks.execute).toHaveBeenCalledTimes(2)
})

it('retains a failed command for retry with the same request id', async () => {
  mocks.execute.mockRejectedValueOnce(new Error('连接中断'))
  const panel = await mount()
  panel.selected.value.add('node:3')
  await panel.execute(action)
  expect(panel.request_error.value).toBe('连接中断')
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
