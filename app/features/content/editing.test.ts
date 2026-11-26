import type { ContentStoryAttachment } from '@shared/types/content'
import type { ContentDraftSnapshot, DraftCommand } from '@shared/types/content-draft'
import type { LintListItem } from './markdown/editor/lint'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computed, effectScope, ref, shallowRef, watch } from 'vue'
import { useContentDraftStore } from './draft.store'
import { useStoryEditSession } from './editing'

const mounted: (() => void)[] = []
const unmounted: (() => void)[] = []
const listeners = new Map<string, EventListener>()
const navigate = vi.fn()
const scopes: ReturnType<typeof effectScope>[] = []
const stores: ReturnType<typeof useContentDraftStore>[] = []
const initial: ContentDraftSnapshot = { id: 'a'.repeat(32), story_id: 7, markdown: 'main', draft_revision: 1, namespace_revision: 0, title_revision: 0, published_main_revision: 1,
  unpublished_changes: false, lease_epoch: 0, occupied: false, owned: false, lease_remaining_ms: 23000, updated_at: '2026-10-30T00:00:00Z', channel: 'content_draft:opaque' }
async function fixture(story_id: number | null = 7, draft_id?: string) {
  const store = useContentDraftStore(story_id)
  stores.push(store)
  const user = ref({ id: 1, is_admin: true, permissions: [] })
  const content = {
    get_draft: vi.fn(async () => ({ snapshot: { ... initial, story_id } })),
    acquire_draft: vi.fn(async () => ({ snapshot: { ... initial, story_id, owned: true, occupied: true, lease_epoch: 1 } })),
    command_draft: vi.fn(async (command: DraftCommand) => ({ snapshot: { ... initial, owned: command.kind !== 'release', occupied: command.kind !== 'release', lease_epoch: 1 }, receipt: { kind: command.kind, seq: command.seq, ok: true } })),
    create_draft: vi.fn(async () => ({ snapshot: { ... initial, story_id: null } })),
    rewrite_draft_references: vi.fn(), get_delete_impact: vi.fn(async () => ({ targets: [], sources: [] })),
  }
  const insert_markdown = vi.fn(() => true)
  const validate = vi.fn<(markdown: string) => readonly LintListItem[] | null>(() => [])
  const start_uploads = vi.fn<Parameters<typeof useStoryEditSession>[0]['start_uploads']>(async () => {})
  const toast = { ok: vi.fn(), error: vi.fn(), info: vi.fn() }
  const scope = effectScope()
  scopes.push(scope)
  let confirmed: (() => void) | undefined
  const editing = scope.run(() => useStoryEditSession({
    story_id, draft_id, draft_store: store, content: content as unknown as Parameters<typeof useStoryEditSession>[0]['content'],
    user: user as unknown as Parameters<typeof useStoryEditSession>[0]['user'], editor: { apply_reference_changes: () => true, validate },
    start_uploads, toast,
    confirm_require: (_event, _message, callback) => { confirmed = callback },
  }))!
  await Promise.resolve()
  return { store, user, content, editing, validate, insert_markdown, start_uploads, toast, confirm: () => confirmed?.() }
}

async function publishing_fixture(story_id: number | null = 7) {
  const f = await fixture(story_id, story_id === null ? initial.id : undefined)
  await f.editing.load()
  f.store.set_visible(true)
  await f.store.cycle()
  f.content.command_draft.mockImplementation(async command => ({
    snapshot: {
      ... f.store.cloud!,
      markdown: command.markdown ?? f.store.cloud!.markdown,
      draft_revision: f.store.cloud!.draft_revision + Number(command.markdown !== undefined),
      story_id: command.kind === 'publish' ? 7 : f.store.cloud!.story_id,
      owned: true, occupied: true, lease_epoch: 1,
    },
    receipt: { kind: command.kind, seq: command.seq, ok: true },
  }))
  return f
}

const lint_error: LintListItem = { from: 0, line: 1, severity: 'error', message: 'Invalid Markdown', source: 'test' }
const lint_warning: LintListItem = { ... lint_error, severity: 'warning' }

function require_review(f: Awaited<ReturnType<typeof fixture>>) {
  f.content.command_draft.mockImplementationOnce(async command => ({
    snapshot: { ... f.store.cloud!, owned: true, occupied: true, lease_epoch: 1 },
    receipt: { kind: command.kind, seq: command.seq, ok: false, error: 'reference_review_required', review_token: 'e'.repeat(64) },
  }))
}
beforeEach(() => {
  setActivePinia(createPinia())
  mounted.length = unmounted.length = 0
  navigate.mockClear()
  for (const [key, value] of Object.entries({ ref, computed, watch, shallowRef })) vi.stubGlobal(key, value)
  vi.stubGlobal('onMounted', (callback: () => void) => mounted.push(callback))
  vi.stubGlobal('onBeforeUnmount', (callback: () => void) => unmounted.push(callback))
  vi.stubGlobal('navigateTo', navigate)
  const addEventListener = (type: string, callback: EventListener) => listeners.set(type, callback)
  const removeEventListener = (type: string) => listeners.delete(type)
  vi.stubGlobal('window', { addEventListener, removeEventListener })
  vi.stubGlobal('document', { visibilityState: 'visible', addEventListener, removeEventListener })
  vi.stubGlobal('useSyncedData', async (_resource: unknown, fetcher: () => Promise<unknown>) => ({ refresh: async () => {
    await fetcher()
  } }))
})
afterEach(() => {
  for (const store of stores.splice(0)) store.clear()
  for (const scope of scopes.splice(0)) scope.stop()
  vi.unstubAllGlobals()
})
describe('cloud edit page adapter', () => {
  const landed_attachment: ContentStoryAttachment = {
    id: 9,
    file_name: 'notes.txt',
    mime_type: 'text/plain',
    file_size: 12,
    is_image: false,
    version: 'v1',
    url: '/attachment/notes.txt',
  }
  const upload_pick = { file: {} as File, file_name: 'notes.txt' }
  const insertion_failure_message = '附件已上传，但自动插入正文失败，请手动插入~'

  it.each([7, null])('blocks errors but allows warnings when publishing story %s, without blocking draft sync', async (story_id) => {
    const f = await publishing_fixture(story_id)
    f.store.markdown = 'draft with diagnostics'
    f.validate.mockReturnValue([lint_warning, lint_error])
    await f.editing.on_save_click()
    expect(f.validate).toHaveBeenCalledExactlyOnceWith('draft with diagnostics')
    expect(f.content.command_draft.mock.calls.map(([command]) => command.kind)).toEqual(['sync'])
    expect(f.store.cloud?.markdown).toBe('draft with diagnostics')
    expect(f.toast.error).toHaveBeenCalledWith('请先修正 Markdown 中的错误，再保存档案')

    f.validate.mockReturnValue(null)
    await f.editing.on_save_click()
    expect(f.content.command_draft.mock.calls.map(([command]) => command.kind)).toEqual(['sync'])
    expect(f.toast.error).toHaveBeenCalledWith('代码编辑器尚未就绪，请稍后再保存')

    f.validate.mockReturnValue([lint_warning])
    await f.editing.on_save_click()
    expect(f.content.command_draft.mock.calls.map(([command]) => command.kind)).toEqual(['sync', 'publish'])
    expect(f.content.command_draft.mock.calls[1]![0]).toMatchObject({ expected_revision: 2 })
    expect(f.toast.ok).toHaveBeenCalledWith('档案已保存')
  })

  it('checks the snapshot after an in-flight sync rewrites it, instead of checking the earlier editor text', async () => {
    const f = await publishing_fixture()
    f.store.markdown = 'earlier editor text'
    let finish!: () => void
    f.content.command_draft.mockImplementationOnce(command => new Promise((resolve) => {
      finish = () => resolve({ snapshot: { ... f.store.cloud!, markdown: 'rewritten invalid text', draft_revision: 2 }, receipt: { kind: command.kind, seq: command.seq, ok: true } })
    }))
    f.validate.mockImplementation(text => text === 'rewritten invalid text' ? [lint_error] : [])
    const save = f.editing.on_save_click()
    expect(f.validate).not.toHaveBeenCalled()
    finish()
    await save
    expect(f.validate).toHaveBeenCalledExactlyOnceWith('rewritten invalid text')
    expect(f.content.command_draft.mock.calls.map(([command]) => command.kind)).toEqual(['sync'])
  })

  it('does not publish a different text introduced during validation', async () => {
    const f = await publishing_fixture()
    f.validate.mockImplementation(() => {
      f.store.markdown = 'changed during validation'
      return []
    })
    await f.editing.on_save_click()
    expect(f.validate).toHaveBeenCalledExactlyOnceWith('main')
    expect(f.content.command_draft).not.toHaveBeenCalled()
  })

  it('checks the new confirmed snapshot after a conservative lease refresh at publish time', async () => {
    const f = await publishing_fixture()
    f.content.get_draft.mockResolvedValueOnce({ snapshot: { ... f.store.cloud!, markdown: 'refreshed invalid text', draft_revision: 2 } })
    f.validate.mockImplementation(text => text === 'refreshed invalid text' ? [lint_error] : [])
    const previous_reads = f.content.get_draft.mock.calls.length
    const current_time = performance.now()
    const clock = vi.spyOn(performance, 'now').mockReturnValueOnce(current_time).mockReturnValue(current_time + 30_000)
    try {
      await f.editing.on_save_click()
    }
    finally {
      clock.mockRestore()
    }
    expect(f.content.get_draft).toHaveBeenCalledTimes(previous_reads + 1)
    expect(f.validate).toHaveBeenCalledExactlyOnceWith('refreshed invalid text')
    expect(f.content.command_draft).not.toHaveBeenCalled()
  })

  it('consumes Ctrl+S through the same lint gate as the save action', async () => {
    const f = await fixture()
    for (const mount of mounted) mount()
    await vi.waitFor(() => expect(f.store.writable).toBe(true))
    f.validate.mockReturnValue([lint_error])
    const preventDefault = vi.fn()
    listeners.get('keydown')!({ key: 's', ctrlKey: true, preventDefault } as unknown as KeyboardEvent)
    await vi.waitFor(() => expect(f.validate).toHaveBeenCalledWith('main'))
    expect(preventDefault).toHaveBeenCalledOnce()
    expect(f.content.command_draft).not.toHaveBeenCalled()
  })

  it('does not turn an autosave history confirmation into a publish', async () => {
    const f = await publishing_fixture()
    f.store.markdown = 'reviewed draft'
    require_review(f)
    await f.store.cycle()
    expect(f.store.review?.text).toBe('reviewed draft')
    await f.editing.confirm_reference_history_save()
    expect(f.content.command_draft.mock.calls.map(([command]) => command.kind)).toEqual(['sync', 'sync'])
    expect(f.validate).not.toHaveBeenCalled()
    expect(f.store.review).toBeNull()
  })

  it.each([false, true])('rechecks lint after an explicit publish history confirmation (error=%s)', async (invalid) => {
    const f = await publishing_fixture()
    f.store.markdown = 'reviewed draft'
    require_review(f)
    await f.editing.on_save_click()
    expect(f.store.review?.text).toBe('reviewed draft')
    expect(f.validate).not.toHaveBeenCalled()
    f.validate.mockReturnValue(invalid ? [lint_error] : [lint_warning])
    await f.editing.confirm_reference_history_save()
    expect(f.validate).toHaveBeenCalledExactlyOnceWith('reviewed draft')
    expect(f.content.command_draft.mock.calls.map(([command]) => command.kind)).toEqual(invalid ? ['sync', 'sync'] : ['sync', 'sync', 'publish'])
  })

  it('does not resume a cancelled publish when the same history review appears again', async () => {
    const f = await publishing_fixture()
    f.store.markdown = 'reviewed draft'
    require_review(f)
    await f.editing.on_save_click()
    const approval = f.store.review!
    f.editing.reference_history_warning_visible.value = false
    f.store.review = approval
    await f.editing.confirm_reference_history_save()
    expect(f.content.command_draft.mock.calls.map(([command]) => command.kind)).toEqual(['sync', 'sync'])
    expect(f.validate).not.toHaveBeenCalled()
  })

  it('does not resume publish when the confirmed history sync has a failed receipt', async () => {
    const f = await publishing_fixture()
    f.store.markdown = 'reviewed draft'
    require_review(f)
    await f.editing.on_save_click()
    f.content.command_draft.mockImplementationOnce(async command => ({
      snapshot: { ... f.store.cloud!, owned: true, occupied: true, lease_epoch: 1 },
      receipt: { kind: command.kind, seq: command.seq, ok: false },
    }))
    await f.editing.confirm_reference_history_save()
    expect(f.content.command_draft.mock.calls.map(([command]) => command.kind)).toEqual(['sync', 'sync'])
    expect(f.validate).not.toHaveBeenCalled()
  })

  it('leaves a removed draft when background retry observes a lost delete result', async () => {
    const f = await fixture()
    await f.editing.load()
    f.store.set_visible(true)
    await f.store.cycle()
    f.content.command_draft.mockRejectedValueOnce(new Error('Delete reply lost'))
    await expect(f.store.action('delete')).rejects.toThrow('Delete reply lost')
    f.content.command_draft.mockRejectedValueOnce(Object.assign(new Error('Absent'), { status: 404 }))
    await f.store.cycle()
    expect(f.store.removed).toBe(true)
    expect(navigate).toHaveBeenCalledWith('/content')
  })
  it('loads and acquires using the server even when Web Locks are absent', async () => {
    const f = await fixture()
    for (const mount of mounted) mount()
    await vi.waitFor(() => expect(f.store.writable).toBe(true))
    expect(f.content.acquire_draft).toHaveBeenCalledOnce()
  })
  it('distinguishes an available draft from one occupied by another page', async () => {
    const f = await fixture()
    await f.editing.load()
    expect(f.editing.draft_status_label.value).toBe('正在取得编辑权……')
    f.store.cloud = { ... initial, occupied: true }
    expect(f.editing.draft_status_label.value).toBe('其他页面正在编辑')
  })
  it('shows recovery until dismissed and resumes the normal indicators for new edits', async () => {
    const f = await publishing_fixture()
    const confirmed = {
      ... f.store.cloud!,
      markdown: '另一页已确认的正文',
      draft_revision: 2,
      unpublished_changes: true,
      occupied: true,
      owned: false,
      lease_epoch: 2,
    }
    f.store.markdown = '本页未保存的正文'
    f.content.command_draft.mockImplementationOnce(async command => ({
      snapshot: confirmed,
      receipt: { kind: command.kind, seq: command.seq, ok: false, error: 'lease_lost' },
    }))
    await f.store.flush_changes(new AbortController().signal)
    expect(f.store.writable).toBe(false)
    expect(f.store.recovery).toBe('本页未保存的正文')
    expect(f.store.markdown).toBe(confirmed.markdown)
    expect(f.editing.draft_status_label.value).toBe('编辑权已变更，恢复区可用')

    f.editing.dismiss_recovery()
    expect(f.store.recovery).toBe('')
    expect(f.editing.draft_status_label.value).toBe('草稿与云端一致')
    f.content.get_draft.mockResolvedValueOnce({ snapshot: { ... confirmed } })
    await f.store.cycle()
    expect(f.editing.draft_status_label.value).toBe('草稿与云端一致')

    f.content.get_draft.mockResolvedValueOnce({ snapshot: { ... confirmed, occupied: false } })
    f.content.acquire_draft.mockResolvedValueOnce({ snapshot: { ... confirmed, owned: true, lease_epoch: 3 } })
    await f.store.cycle()
    expect(f.store.writable).toBe(true)
    f.store.markdown = '重新获得编辑权后的改动'
    expect(f.editing.draft_status_label.value).toBe('修改待保存……')
    await f.store.flush_changes(new AbortController().signal)
    expect(f.store.cloud?.draft_revision).toBe(3)
    expect(f.editing.draft_status_label.value).toBe('草稿已保存，尚未发布')
  })
  it('shows that a saved draft is unpublished before it has a story ID', async () => {
    const f = await publishing_fixture(null)
    expect(f.editing.draft_status_label.value).toBe('草稿已保存，尚未发布')
  })
  it('keeps the saved status during a pure lease renewal', async () => {
    const f = await fixture()
    await f.editing.load()
    f.store.set_visible(true)
    await f.store.cycle()
    let resolve!: (result: Awaited<ReturnType<typeof f.content.command_draft>>) => void
    f.content.command_draft.mockImplementationOnce(() => new Promise((yes) => {
      resolve = yes
    }))
    const renewal = f.store.cycle()
    expect(f.store.request_pending).toBe(true)
    expect(f.editing.draft_status_label.value).toBe('与已发布版本一致')
    resolve({ snapshot: { ... initial, owned: true, occupied: true, lease_epoch: 1 }, receipt: { kind: 'sync', seq: 1, ok: true } })
    await renewal
    expect(f.editing.draft_status_label.value).toBe('与已发布版本一致')
  })
  it('shows an unconfirmed save even if input returns to the previous cloud text', async () => {
    const f = await fixture()
    await f.editing.load()
    f.store.set_visible(true)
    await f.store.cycle()
    let resolve!: (result: Awaited<ReturnType<typeof f.content.command_draft>>) => void
    f.content.command_draft.mockImplementationOnce(() => new Promise((yes) => {
      resolve = yes
    }))
    f.store.markdown = 'edited'
    const saving = f.store.cycle()
    f.store.markdown = initial.markdown
    expect(f.store.dirty).toBe(false)
    expect(f.editing.draft_status_label.value).toBe('修改待保存……')
    resolve({ snapshot: { ... initial, markdown: 'edited', owned: true, occupied: true, lease_epoch: 1, unpublished_changes: true }, receipt: { kind: 'sync', seq: 1, ok: true } })
    await saving
    expect(f.editing.draft_status_label.value).toBe('修改待保存……')
  })
  it('creates an independent server draft and replaces the new-page URL', async () => {
    const f = await fixture(null)
    await f.editing.load()
    expect(f.content.create_draft).toHaveBeenCalledWith(expect.stringMatching(/^[a-f0-9]{32}$/))
    expect(navigate).toHaveBeenCalledWith(`/content/draft-${initial.id}/edit`, { replace: true })
  })
  it('keeps the first open failure visible through background tries and clears it after manual recovery', async () => {
    const f = await fixture()
    f.content.get_draft.mockRejectedValueOnce(new Error('offline')).mockRejectedValueOnce(new Error('still offline'))
    await f.editing.load()
    expect(f.editing.draft_open_error.value).toBe('failed')
    expect(f.toast.error).toHaveBeenCalledExactlyOnceWith('云端草稿加载失败，请重试')
    await f.editing.load()
    expect(f.editing.draft_open_error.value).toBe('failed')
    expect(f.toast.error).toHaveBeenCalledOnce()
    expect(f.content.acquire_draft).not.toHaveBeenCalled()

    await f.editing.ready
    await f.editing.retry_draft_open()
    expect(f.editing.draft_open_error.value).toBeNull()
    expect(f.store.cloud?.id).toBe(initial.id)
  })

  it('reuses the create request ID after the initial request fails', async () => {
    const f = await fixture(null)
    f.content.create_draft.mockRejectedValueOnce(new Error('lost response'))
    await f.editing.load()
    expect(f.editing.draft_open_error.value).toBe('failed')
    expect(f.toast.error).toHaveBeenCalledExactlyOnceWith('新建草稿失败，请重试')
    await f.editing.ready
    await f.editing.retry_draft_open()
    expect(f.content.create_draft).toHaveBeenCalledTimes(2)
    const [first, second] = f.content.create_draft.mock.calls
    expect(first).toEqual([expect.stringMatching(/^[a-f0-9]{32}$/)])
    expect(second).toEqual(first)
    expect(navigate).toHaveBeenCalledExactlyOnceWith(`/content/draft-${initial.id}/edit`, { replace: true })
  })

  it.each([
    [403, 'forbidden', false],
    [404, 'missing', true],
  ] as const)('ends startup requests after a confirmed %s', async (status, reason, redirects) => {
    const f = await fixture()
    f.content.get_draft.mockRejectedValueOnce(Object.assign(new Error(reason), { status }))
    await f.editing.load()
    await f.editing.load()
    expect(f.editing.draft_open_error.value).toBe(reason)
    expect(f.content.get_draft).toHaveBeenCalledOnce()
    expect(f.toast.error).not.toHaveBeenCalled()
    if (redirects)
      expect(navigate).toHaveBeenCalledExactlyOnceWith('/content')
    else
      expect(navigate).not.toHaveBeenCalled()
  })

  it('clears text, undo-session identity and recovery when the account changes', async () => {
    const f = await fixture()
    await f.editing.load()
    f.store.markdown = 'confidential unfinished text'
    f.store.recovery = 'also confidential'
    const old_editor_session = f.editing.editor_session_key.value
    f.user.value = { id: 2, is_admin: true, permissions: [] }
    expect(f.store.markdown).toBe('')
    expect(f.store.recovery).toBe('')
    expect(f.store.cloud).toBeNull()
    expect(f.editing.editor_session_key.value).toBeGreaterThan(old_editor_session)
  })
  it('ignores a previous account response even after A to B to A', async () => {
    const f = await fixture()
    let resolve!: (result: { snapshot: ContentDraftSnapshot }) => void
    f.content.get_draft.mockImplementationOnce(() => new Promise((yes) => {
      resolve = yes
    }))
    const pending = f.editing.load()
    f.user.value = { id: 2, is_admin: true, permissions: [] }
    f.user.value = { id: 1, is_admin: true, permissions: [] }
    resolve({ snapshot: initial })
    await pending
    expect(f.store.markdown).toBe('')
    expect(f.store.cloud).toBeNull()
  })
  it('does not apply an old page load to a remounted same-story store', async () => {
    const f = await fixture()
    let resolve!: (result: { snapshot: ContentDraftSnapshot }) => void
    f.content.get_draft.mockImplementationOnce(() => new Promise((yes) => {
      resolve = yes
    }))
    const pending = f.editing.load()
    const newer = await fixture()
    resolve({ snapshot: { ... initial, markdown: 'stale' } })
    await pending
    expect(newer.store.markdown).toBe('')
  })
  it('binds destructive reset approval to the current revision and input', async () => {
    const f = await fixture()
    for (const mount of mounted) mount()
    await vi.waitFor(() => expect(f.store.writable).toBe(true))
    f.editing.confirm_abandon_draft(new Event('click'))
    f.store.markdown = 'changed after confirmation opened'
    f.confirm()
    expect(f.content.command_draft).not.toHaveBeenCalled()
  })
  it('replaces unsaved input and renews the editor session after a confirmed reset', async () => {
    const f = await fixture()
    await f.editing.load()
    f.store.set_visible(true)
    await f.store.cycle()
    f.store.markdown = 'discard this input'
    const editor_session = f.editing.editor_session_key.value
    f.editing.confirm_abandon_draft(new Event('click'))
    f.confirm()
    await vi.waitFor(() => expect(f.editing.editor_session_key.value).toBeGreaterThan(editor_session))
    expect(f.store.markdown).toBe(initial.markdown)
    expect(f.store.dirty).toBe(false)
    await f.store.cycle()
    expect(f.content.command_draft.mock.calls.map(([command]) => command.kind)).toEqual(['reset', 'sync'])
    expect(f.content.command_draft.mock.calls.every(([command]) => command.markdown === undefined)).toBe(true)
  })
  it('inserts a landed upload while the captured editing permit is still current', async () => {
    const f = await fixture()
    for (const mount of mounted) mount()
    await vi.waitFor(() => expect(f.store.writable).toBe(true))
    await f.editing.upload_picks([upload_pick], f.insert_markdown)
    f.start_uploads.mock.calls[0]![0][0]!.on_landed?.(landed_attachment)
    expect(f.insert_markdown).toHaveBeenCalledWith('[](att://notes.txt)')
    expect(f.toast.info).not.toHaveBeenCalled()
  })
  it('offers manual insertion once per batch when the editor rejects landed references', async () => {
    const f = await fixture()
    for (const mount of mounted) mount()
    await vi.waitFor(() => expect(f.store.writable).toBe(true))
    f.insert_markdown.mockReturnValue(false)
    await f.editing.upload_picks([upload_pick, { ... upload_pick, file_name: 'second.txt' }], f.insert_markdown)
    const entries = f.start_uploads.mock.calls[0]![0]
    entries[0]!.on_landed?.(landed_attachment)
    entries[1]!.on_landed?.({ ... landed_attachment, id: 10, file_name: 'second.txt' })
    expect(f.insert_markdown).toHaveBeenCalledTimes(2)
    expect(f.toast.info).toHaveBeenCalledExactlyOnceWith(insertion_failure_message)
    expect(f.toast.error).not.toHaveBeenCalled()
  })
  it('offers manual insertion when a completed reset invalidates the original insertion point', async () => {
    const f = await fixture()
    for (const mount of mounted) mount()
    await vi.waitFor(() => expect(f.store.writable).toBe(true))
    await f.editing.upload_picks([upload_pick], f.insert_markdown)
    const session = f.editing.editor_session_key.value
    f.editing.confirm_abandon_draft(new Event('click'))
    f.confirm()
    await vi.waitFor(() => expect(f.editing.editor_session_key.value).toBeGreaterThan(session))
    f.start_uploads.mock.calls[0]![0][0]!.on_landed?.(landed_attachment)
    expect(f.insert_markdown).not.toHaveBeenCalled()
    expect(f.toast.info).toHaveBeenCalledExactlyOnceWith(insertion_failure_message)
    expect(f.toast.error).not.toHaveBeenCalled()
  })
  it('keeps list uploads without an insertion callback quiet', async () => {
    const f = await fixture()
    for (const mount of mounted) mount()
    await vi.waitFor(() => expect(f.store.writable).toBe(true))
    await f.editing.upload_picks([upload_pick], null)
    f.start_uploads.mock.calls[0]![0][0]!.on_landed?.(landed_attachment)
    expect(f.insert_markdown).not.toHaveBeenCalled()
    expect(f.toast.info).not.toHaveBeenCalled()
  })
  it('defers a hidden page insertion failure notice until the same page returns', async () => {
    const f = await fixture()
    for (const mount of mounted) mount()
    await vi.waitFor(() => expect(f.store.writable).toBe(true))
    await f.editing.upload_picks([upload_pick], f.insert_markdown)
    vi.stubGlobal('document', { ... document, visibilityState: 'hidden' })
    listeners.get('visibilitychange')!(new Event('visibilitychange'))
    f.start_uploads.mock.calls[0]![0][0]!.on_landed?.(landed_attachment)
    expect(f.insert_markdown).not.toHaveBeenCalled()
    expect(f.toast.info).not.toHaveBeenCalled()

    vi.stubGlobal('document', { ... document, visibilityState: 'visible' })
    listeners.get('visibilitychange')!(new Event('visibilitychange'))
    expect(f.toast.info).toHaveBeenCalledExactlyOnceWith(insertion_failure_message)
    listeners.get('visibilitychange')!(new Event('visibilitychange'))
    expect(f.toast.info).toHaveBeenCalledOnce()
  })
  it('does not insert a late upload after the account changes', async () => {
    const f = await fixture()
    for (const mount of mounted) mount()
    await vi.waitFor(() => expect(f.store.writable).toBe(true))
    await f.editing.upload_picks([upload_pick], f.insert_markdown)
    f.user.value = { id: 2, is_admin: true, permissions: [] }
    f.start_uploads.mock.calls[0]![0][0]!.on_landed?.(landed_attachment)
    expect(f.insert_markdown).not.toHaveBeenCalled()
    expect(f.toast.info).not.toHaveBeenCalled()
  })
  it.each(['publish', 'reset'] as const)('handles an upload landing while %s is awaiting its receipt', async (kind) => {
    const f = await fixture()
    for (const mount of mounted) mount()
    await vi.waitFor(() => expect(f.store.writable).toBe(true))
    await f.editing.upload_picks([upload_pick], f.insert_markdown)
    let finish!: () => void
    f.content.command_draft.mockImplementationOnce(command => new Promise((resolve) => {
      finish = () => resolve({ snapshot: { ... initial, owned: true, occupied: true, lease_epoch: 1 }, receipt: { kind, seq: command.seq, ok: true } })
    }))
    const action = f.store.action(kind)
    f.start_uploads.mock.calls[0]![0][0]!.on_landed?.(landed_attachment)
    expect(f.insert_markdown).not.toHaveBeenCalled()
    expect(f.toast.info).not.toHaveBeenCalled()
    finish()
    await action
    if (kind === 'publish') {
      expect(f.insert_markdown).toHaveBeenCalledWith('[](att://notes.txt)')
      expect(f.toast.info).not.toHaveBeenCalled()
    }
    else {
      expect(f.insert_markdown).not.toHaveBeenCalled()
      expect(f.toast.info).toHaveBeenCalledExactlyOnceWith(insertion_failure_message)
    }
  })
  it('does not insert a late upload after the page exits', async () => {
    const f = await fixture()
    for (const mount of mounted) mount()
    await vi.waitFor(() => expect(f.store.writable).toBe(true))
    await f.editing.upload_picks([upload_pick], f.insert_markdown)
    for (const unmount of unmounted) unmount()
    f.start_uploads.mock.calls[0]![0][0]!.on_landed?.(landed_attachment)
    expect(f.insert_markdown).not.toHaveBeenCalled()
    expect(f.toast.info).not.toHaveBeenCalled()
  })
  it('does not insert a late upload after a replacement editing session takes ownership', async () => {
    const f = await fixture()
    for (const mount of mounted) mount()
    await vi.waitFor(() => expect(f.store.writable).toBe(true))
    await f.editing.upload_picks([upload_pick], f.insert_markdown)
    await fixture()
    f.start_uploads.mock.calls[0]![0][0]!.on_landed?.(landed_attachment)
    expect(f.insert_markdown).not.toHaveBeenCalled()
    expect(f.toast.info).not.toHaveBeenCalled()
  })
  it('rejects attachment uploads before a story exists', async () => {
    const f = await fixture(null)
    await f.editing.upload_picks([upload_pick], f.insert_markdown)
    expect(f.start_uploads).not.toHaveBeenCalled()
    expect(f.toast.error).toHaveBeenCalledWith('请先保存档案')
  })
})
