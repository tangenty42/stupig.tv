import type { StoryEditorPosition } from '~/utils/content/editor/view-state'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { effectScope, nextTick, ref } from 'vue'
import { useStoryEditorViewState } from './useStoryEditorViewState'

const storage = new Map<string, string>()
const fixtures: { unmount: () => void }[] = []
const position: StoryEditorPosition = { anchor: 42, head: 46, editor: { top: 900, left: 12 }, preview: { top: 720, left: 0 }, page: { top: 300, left: 0 } }
let window_events: EventTarget
let document_events: EventTarget

beforeEach(() => {
  storage.clear()
  window_events = new EventTarget()
  document_events = Object.assign(new EventTarget(), { visibilityState: 'visible' })
  vi.stubGlobal('window', window_events)
  vi.stubGlobal('document', document_events)
  vi.stubGlobal('nextTick', nextTick)
  vi.stubGlobal('localStorage', { getItem: vi.fn((key: string) => storage.get(key) ?? null), setItem: vi.fn((key: string, value: string) => storage.set(key, value)) })
})

afterEach(() => {
  fixtures.splice(0).forEach(fixture => fixture.unmount())
  vi.unstubAllGlobals()
})

function setup(key: string | null = '1:draft-a') {
  const mounts: (() => Promise<void>)[] = []
  const unmounts: (() => void)[] = []
  vi.stubGlobal('onMounted', (callback: () => Promise<void>) => mounts.push(callback))
  vi.stubGlobal('onBeforeUnmount', (callback: () => void) => unmounts.push(callback))
  const scope = effectScope()
  const fullscreen = ref(false)
  const mode = ref<'edit' | 'preview'>('edit')
  const audience = ref<'private' | 'public'>('private')
  const split_ratio = ref(0.5)
  const attachments_width = ref(256)
  const capture = vi.fn(() => position)
  const restore = vi.fn()
  scope.run(() => useStoryEditorViewState({ key: () => key, fullscreen, mode, audience, split_ratio, attachments_width, capture, restore }))
  let live = true
  const fixture = { fullscreen, mode, audience, split_ratio, attachments_width, capture, restore,
    mount: () => Promise.all(mounts.map(callback => callback())),
    unmount() {
      if (! live)
        return
      live = false
      unmounts.forEach(callback => callback())
      scope.stop()
    },
  }
  fixtures.push(fixture)
  return fixture
}

it('restores layout and viewport on re-entry without reading storage during setup', async () => {
  const first = setup()
  expect(localStorage.getItem).not.toHaveBeenCalled()
  await first.mount()
  first.fullscreen.value = true
  first.mode.value = 'preview'
  first.audience.value = 'public'
  first.split_ratio.value = 0.65
  first.attachments_width.value = 320
  first.unmount()
  const second = setup()
  await second.mount()
  expect(second.fullscreen.value).toBe(true)
  expect(second.mode.value).toBe('preview')
  expect(second.audience.value).toBe('public')
  expect(second.split_ratio.value).toBe(0.65)
  expect(second.attachments_width.value).toBe(320)
  expect(second.restore).toHaveBeenCalledWith(position)
})

it('saves on reload/pagehide and backgrounding, and isolates accounts and drafts', async () => {
  const fixture = setup()
  await fixture.mount()
  fixture.fullscreen.value = true
  window_events.dispatchEvent(new Event('pagehide'))
  expect(JSON.parse(storage.get('stupig:editor-view:1:draft-a')!).position).toEqual(position)
  fixture.split_ratio.value = 0.7
  Object.assign(document_events, { visibilityState: 'hidden' })
  document_events.dispatchEvent(new Event('visibilitychange'))
  expect(JSON.parse(storage.get('stupig:editor-view:1:draft-a')!).split_ratio).toBe(0.7)
  for (const key of ['2:draft-a', '1:draft-b']) {
    const other = setup(key)
    await other.mount()
    expect(other.fullscreen.value).toBe(false)
    expect(other.restore).not.toHaveBeenCalled()
  }
})

it('tolerates malformed/denied storage and does not persist unscoped editors', async () => {
  storage.set('stupig:editor-view:1:draft-a', '{broken')
  await setup().mount()
  vi.mocked(localStorage.getItem).mockImplementation(() => {
    throw new Error('denied')
  })
  vi.mocked(localStorage.setItem).mockImplementation(() => {
    throw new Error('quota')
  })
  const denied = setup()
  await denied.mount()
  expect(() => denied.unmount()).not.toThrow()
  const unscoped = setup(null)
  await unscoped.mount()
  vi.mocked(localStorage.setItem).mockClear()
  unscoped.unmount()
  expect(localStorage.setItem).not.toHaveBeenCalled()
})

it('does not restore after unmounting during the mount continuation', async () => {
  storage.set('stupig:editor-view:1:draft-a', JSON.stringify({ version: 1, position }))
  const fixture = setup()
  const mounting = fixture.mount()
  fixture.unmount()
  await mounting
  expect(fixture.restore).not.toHaveBeenCalled()
})
