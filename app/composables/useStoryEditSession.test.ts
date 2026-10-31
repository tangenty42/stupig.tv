import type { ContentDraftSnapshot, DraftCommand } from '@shared/types/content-draft'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computed, effectScope, ref, shallowRef, watch } from 'vue'
import { useContentDraftStore } from '~/stores/contentDraft'
import { useStoryEditSession } from './useStoryEditSession'

const mounted: (() => void)[] = []
const unmounted: (() => void)[] = []
const listeners = new Map<string, EventListener>()
const navigate = vi.fn()
const scopes: ReturnType<typeof effectScope>[] = []
const stores: ReturnType<typeof useContentDraftStore>[] = []
const initial: ContentDraftSnapshot = { id: 'a'.repeat(32), story_id: 7, markdown: 'main', draft_revision: 1, namespace_revision: 0, title_revision: 0, published_main_revision: 1,
  unpublished_changes: false, lease_epoch: 0, occupied: false, owned: false, lease_remaining_ms: 23000, updated_at: '2026-10-30T00:00:00Z', channel: 'content_draft:opaque' }
async function fixture(story_id: number | null = 7) {
  const store = useContentDraftStore(story_id)
  stores.push(store)
  const user = ref({ id: 1, is_admin: true, permissions: [] })
  const content = {
    get_draft: vi.fn(async () => ({ snapshot: { ... initial } })),
    acquire_draft: vi.fn(async () => ({ snapshot: { ... initial, owned: true, occupied: true, lease_epoch: 1 } })),
    command_draft: vi.fn(async (command: DraftCommand) => ({ snapshot: { ... initial, owned: command.kind !== 'release', occupied: command.kind !== 'release', lease_epoch: 1 }, receipt: { kind: command.kind, seq: command.seq, ok: true } })),
    create_draft: vi.fn(async () => ({ snapshot: { ... initial, story_id: null } })),
    rewrite_draft_references: vi.fn(), get_delete_impact: vi.fn(async () => ({ targets: [], sources: [] })),
  }
  const scope = effectScope()
  scopes.push(scope)
  let confirmed: (() => void) | undefined
  const editing = scope.run(() => useStoryEditSession({
    story_id, draft_store: store, content: content as unknown as Parameters<typeof useStoryEditSession>[0]['content'],
    user: user as unknown as Parameters<typeof useStoryEditSession>[0]['user'], workspace: ref(null), title_reference_version: ref(null), markdown_editor: ref(undefined),
    markdown_config: () => ({ title_max_length: 60, label_max_bytes: 255, desc_max_bytes: 500, cover_max_bytes: 255, markdown_max_bytes: 1048576 }), new_markdown: () => '', toast: { ok: vi.fn(), error: vi.fn() },
    confirm_require: (_event, _message, callback) => { confirmed = callback },
  }))!
  await Promise.resolve()
  return { store, user, content, editing, confirm: () => confirmed?.() }
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
    expect(f.editing.draft_status_label.value).toBe('正在取得编辑权…')
    f.store.cloud = { ... initial, occupied: true }
    expect(f.editing.draft_status_label.value).toBe('其他页面正在编辑')
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
    expect(f.editing.draft_status_label.value).toBe('草稿与云端一致')
    resolve({ snapshot: { ... initial, owned: true, occupied: true, lease_epoch: 1 }, receipt: { kind: 'sync', seq: 1, ok: true } })
    await renewal
    expect(f.editing.draft_status_label.value).toBe('草稿与云端一致')
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
    expect(f.editing.draft_status_label.value).toBe('修改待上传…')
    resolve({ snapshot: { ... initial, markdown: 'edited', owned: true, occupied: true, lease_epoch: 1, unpublished_changes: true }, receipt: { kind: 'sync', seq: 1, ok: true } })
    await saving
    expect(f.editing.draft_status_label.value).toBe('修改待上传…')
  })
  it('creates an independent server draft and replaces the new-page URL', async () => {
    const f = await fixture(null)
    await f.editing.load()
    expect(f.content.create_draft).toHaveBeenCalledWith(expect.stringMatching(/^[a-f0-9]{32}$/))
    expect(navigate).toHaveBeenCalledWith(`/content/draft-${initial.id}/edit`, { replace: true })
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
})
