import type { DraftReferenceSnapshot } from '~/utils/content/draft-reference-bridge'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { createPinia, setActivePinia } from 'pinia'
import ts from 'typescript'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { computed, effectScope, isRef, nextTick, reactive, ref, watch } from 'vue'
import { get_error_status } from '~/composables/useApi'
import { useStoryEditSession } from '~/composables/useStoryEditSession'
import { useSyncedData } from '~/composables/useSyncedData'
import { useSyncedState } from '~/composables/useSyncedState'
import { useContentDraftStore } from '~/stores/contentDraft'

// Run the actual setup and sync setter with the real draft store and query.
// This guards their wiring without adding a DOM dependency or duplicating the
// page's merge/deletion logic in a test-only component.
const source = readFileSync(new URL('./edit.vue', import.meta.url), 'utf8')
const setup = source.slice(source.indexOf('const title_reference_version ='), source.indexOf('\nasync function upload_picks(')).replaceAll('import.meta.client', 'true')
const saved = { id: 7, markdown: 'saved', revision: 2, namespace_revision: 3, title_revision: 1, viewer_key: '1:true', has_private: false, private_readable: true }
const fetcher = vi.fn<() => Promise<typeof saved>>()
const listeners = new Map<string, () => Promise<void>>()
const storage = new Map<string, string>()
const disposers: (() => void)[] = []
const drafts: ReturnType<typeof useContentDraftStore>[] = []
const update = vi.fn()
const remove = vi.fn()
const rewrite = vi.fn()
let confirmed: () => Promise<void>

beforeEach(() => {
  setActivePinia(createPinia())
  listeners.clear()
  storage.clear()
  fetcher.mockReset().mockResolvedValue(saved)
  update.mockReset()
  remove.mockReset().mockResolvedValue(undefined)
  rewrite.mockReset().mockImplementation(async (_id: number, snapshot: DraftReferenceSnapshot) => ({
    markdown: snapshot.markdown, changes: [], diagnostics: [], baseline_unavailable: { namespace: false, title: false },
    namespace_revision: snapshot.namespace_revision, title_revision: snapshot.title_revision,
    base_namespace_revision: snapshot.namespace_revision, base_title_revision: snapshot.title_revision,
  }))
  const app = { isHydrating: false }
  for (const [name, value] of Object.entries({ computed, effectScope, isRef, ref, watch, get_error_status, useSyncedState }))
    vi.stubGlobal(name, value)
  vi.stubGlobal('useState', (_key: string, init: () => unknown) => ref(init()))
  vi.stubGlobal('onUnmounted', (fn: () => void) => disposers.push(fn))
  vi.stubGlobal('onBeforeUnmount', (fn: () => void) => disposers.push(fn))
  vi.stubGlobal('onMounted', vi.fn())
  vi.stubGlobal('window', new EventTarget())
  vi.stubGlobal('navigateTo', vi.fn())
  vi.stubGlobal('useNuxtApp', () => app)
  vi.stubGlobal('useMyToast', () => ({ error: vi.fn() }))
  vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) })
  vi.stubGlobal('useDataSync', () => ({ subscribe: (key: string, callback: () => Promise<void>) => {
    listeners.set(key, callback)
    return () => listeners.delete(key)
  } }))
})

afterEach(() => {
  disposers.splice(0).forEach(dispose => dispose())
  drafts.splice(0).forEach((draft) => {
    draft.suspend()
    draft.$dispose()
  })
  vi.unstubAllGlobals()
})

async function open() {
  const draft = useContentDraftStore(7)
  drafts.push(draft)
  const context = {
    computed, ref, useSyncedState, useSyncedData, useStoryEditSession,
    is_edit: ref(true), story_id: ref(7), draft_story_id: 7,
    content: { get_story_body: fetcher, get_title_reference_version: async () => ({ title_revision: 1 }), update_story: update, delete_story: remove, rewrite_draft_references: rewrite },
    error: vi.fn(), ok: vi.fn(), attachment_workspace: { data: ref(null), loading: ref(false) }, user: ref({ id: 1 }),
    attachment_panel: { uploads: { finalizing: reactive(new Set<string>()) } },
    draft_store: draft, markdown_editor: ref({ validate: () => [], apply_reference_changes: vi.fn(() => true) }), content_markdown_config: ref({}),
    story_markdown_template: () => '', datetime_build_string: () => '', time_context: ref({ now_ms: 0, timezone: 'UTC' }),
    confirm_require: (_event: unknown, _message: string, action: () => Promise<void>) => { confirmed = action },
    sync_resource: (type: string, id: string | number) => `${type}:${id}`,
  }
  const editing = await runInNewContext(ts.transpile(`(async () => {${setup}; return editing})()`), context) as ReturnType<typeof useStoryEditSession>
  return { ... editing, draft, editor: context.markdown_editor, upload_finalizing: context.attachment_panel.uploads.finalizing, workspace_loading: context.attachment_workspace.loading }
}

it('persists unsaved text before clearing a deleted editor and preserves it on remount', async () => {
  const { story, draft } = await open()
  draft.markdown = 'saved\nunsaved local words'
  await nextTick()
  fetcher.mockRejectedValue(Object.assign(new Error('gone'), { status: 404 }))
  await listeners.get('content_story:7')!()
  expect(story.value).toBeNull()
  expect(draft.initialized).toBe(false)
  expect(draft.markdown).toContain('unsaved local words')
  expect(draft.read_persisted()?.markdown).toBe('saved\nunsaved local words')
  draft.persist_now()
  const again = await open()
  again.draft.persist_now()
  expect(again.story.value).toBeNull()
  expect(again.draft.initialized).toBe(false)
  expect(again.draft.read_persisted()?.markdown).toBe('saved\nunsaved local words')
})

it('does not erase a persisted draft when a deleted editor is opened after a reload', async () => {
  const { draft } = await open()
  draft.markdown = 'persisted before reload'
  draft.persist_now()
  draft.suspend()
  setActivePinia(createPinia())
  fetcher.mockRejectedValue({ statusCode: 404 })
  const reloaded = await open()
  reloaded.draft.persist_now()
  expect(reloaded.story.value).toBeNull()
  expect(reloaded.draft.initialized).toBe(false)
  expect(reloaded.draft.read_persisted()?.markdown).toBe('persisted before reload')
})

it('keeps the editor and unsaved text after a transient sync failure', async () => {
  const { story, draft } = await open()
  draft.markdown = 'unsaved local words'
  fetcher.mockRejectedValue({ status: 503 })
  await listeners.get('content_story:7')!()
  expect(story.value).toEqual(saved)
  expect(draft.initialized).toBe(true)
  expect(draft.markdown).toBe('unsaved local words')
})

function persist_other_tab_draft() {
  // Separate Pinia instances share browser storage, like two tabs do.
  setActivePinia(createPinia())
  const other = useContentDraftStore(7)
  drafts.push(other)
  other.initialize(saved.markdown, saved.revision)
  other.markdown = 'unsaved text from another tab'
  other.persist_now()
  return other.read_persisted()
}

it('does not let a clean deleted editor erase another tab\'s saved draft', async () => {
  const { draft } = await open()
  const persisted = persist_other_tab_draft()
  fetcher.mockRejectedValue({ status: 404 })
  await listeners.get('content_story:7')!()
  expect(draft.read_persisted()).toEqual(persisted)
})

it('does not erase another tab\'s draft when the initiating delete request completes', async () => {
  const { draft, confirm_delete_story } = await open()
  const persisted = persist_other_tab_draft()
  confirm_delete_story({} as Event)
  await confirmed()
  expect(remove).toHaveBeenCalledWith(7)
  expect(draft.initialized).toBe(false)
  expect(draft.read_persisted()).toEqual(persisted)
})

it('ignores a save shortcut once the story is known to be missing', async () => {
  const { story, on_save_click } = await open()
  story.value = null
  on_save_click()
  expect(update).not.toHaveBeenCalled()
})

it('sends all three base revisions and preserves edits typed while save is in flight', async () => {
  const f = await open()
  let finish!: (value: object) => void
  update.mockImplementation(() => new Promise((resolve) => {
    finish = resolve
  }))
  f.draft.markdown = 'submitted'
  f.on_save_click()
  expect(update).toHaveBeenCalledExactlyOnceWith(7, { markdown: 'submitted', base_revision: 2, base_namespace_revision: 3, base_title_revision: 1 })
  expect(f.save_pending.value).toBe(true)
  f.draft.markdown = 'typed while saving'
  fetcher.mockResolvedValue({ ... saved, markdown: 'normalized submitted', revision: 3 })
  finish({ markdown: 'normalized submitted', revision: 3, namespace_revision: 3, title_revision: 1 })
  await vi.waitFor(() => expect(f.save_pending.value).toBe(false))
  expect(f.draft.markdown).toBe('typed while saving')
  expect(f.draft.base_revision).toBe(3)
  expect(f.draft.dirty).toBe(true)
})

it.each(['database', 'local'])('keeps the existing conflict dialog and applies the %s choice', async (choice) => {
  const f = await open()
  f.draft.markdown = 'local edits'
  update.mockRejectedValueOnce({ statusCode: 409 })
  fetcher.mockResolvedValue({ ... saved, markdown: 'latest database', revision: 5 })
  f.on_save_click()
  await vi.waitFor(() => expect(f.draft_conflict_visible.value).toBe(true))
  expect(f.pending_conflict_draft.value?.markdown).toBe('local edits')
  if (choice === 'database') {
    f.use_database_version()
    expect(f.draft.markdown).toBe('latest database')
    expect(f.draft.read_persisted()).toBeNull()
  }
  else {
    update.mockResolvedValue({ markdown: 'local edits', revision: 6, namespace_revision: 3, title_revision: 1 })
    fetcher.mockResolvedValue({ ... saved, markdown: 'local edits', revision: 6 })
    f.restore_conflicting_draft()
    expect(update.mock.calls[1]![1]).toMatchObject({ markdown: 'local edits', base_revision: 5 })
    await vi.waitFor(() => expect(f.save_pending.value).toBe(false))
    expect(f.draft.markdown).toBe('local edits')
  }
  expect(f.draft_conflict_visible.value).toBe(false)
})

it('preserves unsaved private text locally before suspending an unreadable representation', async () => {
  const f = await open()
  f.draft.markdown = 'private unsaved words'
  fetcher.mockResolvedValue({ ... saved, markdown: 'stripped', has_private: true, private_readable: false })
  await listeners.get('content_story:7')!()
  expect(f.draft.read_persisted()?.markdown).toBe('private unsaved words')
  expect(f.draft.markdown).toBe('stripped')
  expect(f.private_blocked.value).toBe(true)
  expect(f.draft.initialized).toBe(false)
})

it.each(['discard', 'conflict'])('restores reference baselines with the database body after %s', async (choice) => {
  const f = await open()
  f.draft.markdown = 'local edits'
  f.reference_review.value = {
    markdown: 'local edits', changes: [], diagnostics: [],
    baseline_unavailable: { namespace: true, title: true },
    namespace_revision: 3, title_revision: 1,
    base_namespace_revision: null, base_title_revision: null,
  }
  const latest = { ... saved, markdown: 'latest database', revision: 5, namespace_revision: 8, title_revision: 6 }
  fetcher.mockResolvedValue(latest)
  if (choice === 'discard') {
    f.confirm_abandon_draft({} as Event)
    await confirmed()
  }
  else {
    update.mockRejectedValueOnce({ statusCode: 409 })
    f.on_save_click()
    await vi.waitFor(() => expect(f.draft_conflict_visible.value).toBe(true))
    f.use_database_version()
  }
  expect(f.draft.markdown).toBe(latest.markdown)
  expect([f.draft.base_revision, f.draft.base_namespace_revision, f.draft.base_title_revision]).toEqual([5, 8, 6])
  expect(f.reference_review.value).toBeNull()
  expect(f.draft.dirty).toBe(false)
  expect(f.draft.read_persisted()).toBeNull()
  f.draft.markdown += '\nnext edit'
  f.on_save_click()
  expect(update.mock.lastCall?.[1]).toMatchObject({ base_revision: 5, base_namespace_revision: 8, base_title_revision: 6 })
})

it('rewrites references through the editor surface and advances namespace/title baselines together', async () => {
  const f = await open()
  f.draft.markdown = 'saved local'
  rewrite.mockImplementationOnce(async (_id: number, snapshot: DraftReferenceSnapshot) => ({
    markdown: 'rewritten local', changes: [{ from: 0, to: 5, insert: 'rewritten' }], diagnostics: [],
    namespace_revision: snapshot.namespace_revision, title_revision: snapshot.title_revision,
    base_namespace_revision: snapshot.namespace_revision, base_title_revision: snapshot.title_revision,
    baseline_unavailable: { namespace: false, title: false },
  }))
  fetcher.mockResolvedValue({ ... saved, namespace_revision: 4, title_revision: 2 })
  await listeners.get('content_story:7')!()
  await vi.waitFor(() => expect(f.draft.markdown).toBe('rewritten local'))
  expect(f.editor.value.apply_reference_changes).toHaveBeenCalledWith('saved local', [{ from: 0, to: 5, insert: 'rewritten' }])
  expect([f.draft.base_namespace_revision, f.draft.base_title_revision]).toEqual([4, 2])
})

it.each(['success', 'failure'])('locks the body throughout a delayed reference rewrite and unlocks after %s', async (outcome) => {
  const f = await open()
  f.draft.markdown = 'saved local'
  await nextTick()
  let finish!: (result: unknown) => void
  let fail!: (reason: Error) => void
  rewrite.mockImplementationOnce(() => new Promise((resolve, reject) => {
    finish = resolve
    fail = reject
  }))
  f.synced_story.value = { ... f.story.value!, namespace_revision: 4, title_revision: 2 }
  expect(f.reference_rewrite_pending.value).toBe(true)
  expect(f.draft_status_label.value).toBe('正在更新正文引用...')
  expect(f.draft.markdown).toBe('saved local')
  if (outcome === 'success') {
    f.editor.value.apply_reference_changes.mockImplementationOnce(() => {
      expect(f.reference_rewrite_pending.value).toBe(true)
      return true
    })
    finish({ markdown: 'updated local', changes: [{ from: 0, to: 5, insert: 'updated' }], diagnostics: [],
      namespace_revision: 4, title_revision: 2, base_namespace_revision: 4, base_title_revision: 2,
      baseline_unavailable: { namespace: false, title: false } })
  }
  else {
    fail(new Error('offline'))
  }
  await vi.waitFor(() => expect(f.reference_rewrite_pending.value).toBe(false))
  expect(f.draft.markdown).toBe(outcome === 'success' ? 'updated local' : 'saved local')
  // Verify the actual page carries the session lock to the editor component.
  expect(source).toContain(':readonly="reference_rewrite_pending"')
})

it('locks before a delayed body refresh and hands off continuously to reference rewriting', async () => {
  const f = await open()
  f.draft.markdown = 'saved local'
  let receive!: (value: typeof saved) => void
  let rewritten!: (value: unknown) => void
  fetcher.mockImplementationOnce(() => new Promise(resolve => receive = resolve))
  rewrite.mockImplementationOnce(() => new Promise(resolve => rewritten = resolve))
  const transitions: boolean[] = []
  const stop = watch(f.reference_rewrite_pending, value => transitions.push(value), { flush: 'sync' })
  f.upload_finalizing.add('upload')
  const refreshed = listeners.get('content_story:7')!()
  expect(f.story_sync_pending.value).toBe(true)
  expect(f.reference_rewrite_pending.value).toBe(true)
  // Receipt arrives while the already-requested body is still in flight.
  f.upload_finalizing.delete('upload')
  expect(f.reference_rewrite_pending.value).toBe(true)
  f.on_save_click()
  expect(update).not.toHaveBeenCalled()
  receive({ ... saved, namespace_revision: 4 })
  await refreshed
  expect(f.story_sync_pending.value).toBe(false)
  expect(f.reference_rewrite_pending.value).toBe(true)
  expect(transitions).toEqual([true])
  rewritten({ markdown: 'rewritten local', changes: [], diagnostics: [], namespace_revision: 4, title_revision: 1,
    base_namespace_revision: 4, base_title_revision: 1, baseline_unavailable: { namespace: false, title: false } })
  await vi.waitFor(() => expect(f.reference_rewrite_pending.value).toBe(false))
  expect(f.draft.markdown).toBe('rewritten local')
  expect(transitions).toEqual([true, false])
  stop()
})

it('keeps the editor fenced through overlapping upload finalization and attachment refreshes', async () => {
  const f = await open()
  f.upload_finalizing.add('first')
  f.upload_finalizing.add('second')
  expect(f.reference_rewrite_pending.value).toBe(true)
  f.upload_finalizing.delete('first')
  expect(f.reference_rewrite_pending.value).toBe(true)
  f.workspace_loading.value = true
  f.upload_finalizing.delete('second')
  expect(f.reference_rewrite_pending.value).toBe(true)
  f.workspace_loading.value = false
  expect(f.reference_rewrite_pending.value).toBe(false)
})

it('rejects save hotkeys and direct save actions throughout upload finalization', async () => {
  const f = await open()
  f.draft.markdown = 'unsaved local'
  f.upload_finalizing.add('upload')
  f.on_save_click()
  expect(update).not.toHaveBeenCalled()
  expect(f.save_pending.value).toBe(false)
  f.upload_finalizing.delete('upload')
  update.mockResolvedValue({ ... saved, markdown: f.draft.markdown, revision: 3 })
  f.on_save_click()
  await vi.waitFor(() => expect(f.save_pending.value).toBe(false))
  expect(update).toHaveBeenCalledOnce()
})

it('releases a delayed body-refresh fence after network failure without replacing local text', async () => {
  const f = await open()
  f.draft.markdown = 'local edits'
  let reject!: (error: Error) => void
  fetcher.mockImplementationOnce(() => new Promise((_resolve, fail) => reject = fail))
  const pending = listeners.get('content_story:7')!()
  expect(f.reference_rewrite_pending.value).toBe(true)
  reject(new Error('offline'))
  await pending
  expect(f.reference_rewrite_pending.value).toBe(false)
  expect(f.draft.markdown).toBe('local edits')
})
