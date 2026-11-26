import type { ContentAttachmentWorkspace, ContentStorySummary } from '@shared/types/content'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { computed, effectScope, ref, shallowRef, watch } from 'vue'

const mocks = vi.hoisted(() => ({
  stories: vi.fn(),
  panel: vi.fn(),
}))

vi.mock('./stories', () => ({ useContentStories: (... args: unknown[]) => mocks.stories(... args) }))
vi.mock('./attachments/panel', () => ({ useAttachmentPanel: (... args: unknown[]) => mocks.panel(... args) }))

const { useStoryEditing } = await import('./editing')
let scope: ReturnType<typeof effectScope>

beforeEach(() => {
  setActivePinia(createPinia())
  scope = effectScope()
  for (const [name, value] of Object.entries({ computed, ref, shallowRef, watch }))
    vi.stubGlobal(name, value)
  vi.stubGlobal('onMounted', vi.fn())
  vi.stubGlobal('onBeforeUnmount', vi.fn())
  vi.stubGlobal('useApi', () => ({ content: {
    get_draft: vi.fn(),
    acquire_draft: vi.fn(),
    command_draft: vi.fn(),
    rewrite_draft_references: vi.fn(),
    create_draft: vi.fn(),
    get_delete_impact: vi.fn(),
  } }))
  vi.stubGlobal('useAuth', () => ({ user: ref({ id: 1, is_admin: true, permissions: [] }) }))
  vi.stubGlobal('useMyToast', () => ({ ok: vi.fn(), error: vi.fn() }))
  vi.stubGlobal('useMyConfirm', () => ({ confirm_require: vi.fn() }))
})

afterEach(() => {
  scope.stop()
  vi.unstubAllGlobals()
})

it('initializes every editing context synchronously and exposes one readiness barrier', async () => {
  let resolve_stories!: () => void
  let resolve_panel!: () => void
  let resolve_session!: (query: { refresh: () => Promise<void> }) => void
  const stories_ready = new Promise<void>((resolve) => {
    resolve_stories = resolve
  })
  const panel_ready = new Promise<void>((resolve) => {
    resolve_panel = resolve
  })
  const session_ready = new Promise<{ refresh: () => Promise<void> }>((resolve) => {
    resolve_session = resolve
  })
  const stories_error = ref(false)
  const stories_loading = ref(false)
  const stories = ref<ContentStorySummary[] | null>(null)
  const catalog_data = ref<ContentAttachmentWorkspace | null>(null)
  const catalog_error = ref<string | null>(null)
  const catalog_loading = ref(false)
  mocks.stories.mockReturnValue({ stories, loading: stories_loading, error: stories_error, ready: stories_ready })
  mocks.panel.mockReturnValue({
    ready: panel_ready,
    start: vi.fn(async () => {}),
    uploads: { finalizing: new Set() },
    catalog: { data: catalog_data, loading: catalog_loading, error: catalog_error, active: true },
  })
  vi.stubGlobal('useSyncedData', () => session_ready)

  const interaction = { open_url: vi.fn(), save_url: vi.fn() }
  const editing = scope.run(() => useStoryEditing({
    story_id: 7,
    attachment_interaction: interaction,
    editor: { apply_reference_changes: () => true, validate: () => [] },
  }))!
  let settled = false
  void editing.ready.then(() => {
    settled = true
  })

  expect(mocks.stories).toHaveBeenCalledOnce()
  expect(mocks.panel).toHaveBeenCalledOnce()
  expect(mocks.panel).toHaveBeenCalledWith({ scope: 7, markdown: expect.any(Function), reference_source: expect.any(Function), interaction })
  expect(editing.stories_completion_failure.value).toBeUndefined()
  expect(editing.attachments_completion_failure.value).toBeUndefined()
  stories_error.value = true
  catalog_error.value = '连接中断'
  expect(editing.stories_completion_failure.value).toBe('load')
  expect(editing.attachments_completion_failure.value).toBe('load')
  stories.value = []
  catalog_data.value = { root_id: 10, nodes: [], attachments: [], folders: [], namespace_revision: 1, viewer_key: '1:true' }
  expect(editing.stories_completion_failure.value).toBe('refresh')
  expect(editing.attachments_completion_failure.value).toBe('refresh')
  stories_loading.value = true
  catalog_loading.value = true
  expect(editing.stories_completion_failure.value).toBeUndefined()
  expect(editing.attachments_completion_failure.value).toBeUndefined()
  stories_error.value = false
  stories_loading.value = false
  catalog_error.value = null
  catalog_loading.value = false
  expect(editing.stories_completion_failure.value).toBeUndefined()
  expect(editing.attachments_completion_failure.value).toBeUndefined()
  expect(settled).toBe(false)
  resolve_stories()
  resolve_panel()
  await Promise.resolve()
  expect(settled).toBe(false)
  resolve_session({ refresh: async () => {} })
  await editing.ready
  expect(settled).toBe(true)
})
