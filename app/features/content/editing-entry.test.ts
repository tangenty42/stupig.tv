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
  mocks.stories.mockReturnValue({ stories: ref([]), loading: ref(false), ready: stories_ready })
  mocks.panel.mockReturnValue({
    ready: panel_ready,
    start: vi.fn(async () => {}),
    uploads: { finalizing: new Set() },
    catalog: { data: ref(null), loading: ref(false) },
  })
  vi.stubGlobal('useSyncedData', () => session_ready)

  const interaction = { open_url: vi.fn(), save_url: vi.fn() }
  const editing = scope.run(() => useStoryEditing({
    story_id: 7,
    attachment_interaction: interaction,
    editor: { apply_reference_changes: () => true, insert_markdown: vi.fn() },
  }))!
  let settled = false
  void editing.ready.then(() => {
    settled = true
  })

  expect(mocks.stories).toHaveBeenCalledOnce()
  expect(mocks.panel).toHaveBeenCalledOnce()
  expect(mocks.panel).toHaveBeenCalledWith({ scope: 7, markdown: expect.any(Function), interaction })
  expect(settled).toBe(false)
  resolve_stories()
  resolve_panel()
  await Promise.resolve()
  expect(settled).toBe(false)
  resolve_session({ refresh: async () => {} })
  await editing.ready
  expect(settled).toBe(true)
})
