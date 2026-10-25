import type { EditorState, Transaction, TransactionSpec } from '@codemirror/state'
import type { ViewUpdate } from '@codemirror/view'
import type { ContentStoryAttachment, ContentStorySummary } from '@shared/types/content'
import { undo } from '@codemirror/commands'
import { EditorView, keymap } from '@codemirror/view'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { computed, effectScope, nextTick, reactive, ref, watch } from 'vue'
import { useMarkdownEditorScrollSync } from './useMarkdownEditorScrollSync'
import { useMarkdownSearch } from './useMarkdownSearch'
import { useStoryEditor } from './useStoryEditor'

const boundary = vi.hoisted(() => ({ views: [] as unknown[], lifecycle: [] as string[] }))
// Only the DOM view is replaced. Transactions, history, extensions, search,
// lint, Vue watchers and the scroll-sync owner run their real implementations.
vi.mock('@codemirror/view', async (original) => {
  const actual = await original<typeof import('@codemirror/view')>()
  class TestView {
    state: EditorState
    scrollDOM = new EventTarget()
    focus = vi.fn()
    requestMeasure = vi.fn()
    destroy = vi.fn(() => boundary.lifecycle.push('destroy'))
    plugin = () => null
    posAtCoords = () => null
    constructor(options: { state: EditorState }) {
      this.state = options.state
      boundary.views.push(this)
    }

    dispatch = (spec: TransactionSpec | Transaction) => {
      const startState = this.state
      const transaction = 'startState' in spec ? spec : startState.update(spec)
      this.state = transaction.state
      const update = { view: this, startState, state: this.state, transactions: [transaction], docChanged: transaction.docChanged } as unknown as ViewUpdate
      for (const listener of this.state.facet(actual.EditorView.updateListener))
        listener(update)
    }
  }
  Object.setPrototypeOf(TestView, actual.EditorView)
  return { ... actual, EditorView: TestView }
})

const fixtures: ReturnType<typeof setup>[] = []
const baseline = '---\ntitle: 编辑器验收\ntime: 2026/10/18\n---\n\nalpha alpha\n'
let theme = ref<'light' | 'dark'>('light')
let window_target: EventTarget

beforeEach(() => {
  boundary.views.length = 0
  boundary.lifecycle.length = 0
  theme = ref('light')
  window_target = new EventTarget()
  const remove = window_target.removeEventListener.bind(window_target)
  vi.spyOn(window_target, 'removeEventListener').mockImplementation((... args) => {
    if (args[0] === 'resize')
      boundary.lifecycle.push('detach')
    remove(... args)
  })
  for (const [name, value] of Object.entries({ ref, computed, reactive, watch, nextTick, useMarkdownSearch, useMarkdownEditorScrollSync, window: window_target }))
    vi.stubGlobal(name, value)
  vi.stubGlobal('useMyColorMode', () => theme)
})

afterEach(() => {
  for (const fixture of fixtures.splice(0))
    fixture.unmount()
  vi.unstubAllGlobals()
})

function setup() {
  const scope = effectScope()
  const mounts: (() => void)[] = []
  const unmounts: (() => void)[] = []
  vi.stubGlobal('onMounted', (fn: () => void) => mounts.push(fn))
  vi.stubGlobal('onBeforeUnmount', (fn: () => void) => unmounts.push(fn))
  const model = ref(baseline)
  const mode = ref<'edit' | 'preview'>('edit')
  const fullscreen = ref(false)
  const readonly = ref(false)
  const attachments = ref<ContentStoryAttachment[]>([])
  const stories = ref<ContentStorySummary[]>([])
  const folders = ref<string[]>([])
  const on_lint = vi.fn()
  const preview = Object.assign(new EventTarget(), { querySelector: () => null }) as unknown as HTMLElement
  const api = scope.run(() => useStoryEditor({ model, host: ref(), preview_pane: ref(preview), fullscreen, mode, readonly: () => readonly.value,
    sources: { attachments: () => attachments.value, stories: () => stories.value, story_id: () => null, folders: () => folders.value },
    on_lint, on_files_pasted: vi.fn(),
  }))!
  let live = true
  return {
    api, model, mode, fullscreen, readonly, attachments, stories, folders, on_lint,
    mount() {
      mounts.forEach(fn => fn())
      return boundary.views.at(- 1) as EditorView
    },
    unmount() {
      if (! live)
        return
      live = false
      unmounts.forEach(fn => fn())
      scope.stop()
    },
  }
}

function create() {
  const fixture = setup()
  fixtures.push(fixture)
  return fixture
}

it('locks editing immediately without remounting and still applies automatic reference updates', async () => {
  const { api, model, readonly, mount } = create()
  const view = mount()
  api.insert_at_position('typed', model.value.length)
  api.search.open_search()
  api.search.query = 'alpha'
  api.search.replace = 'LOST'
  await nextTick()
  api.search.find_next()
  const snapshot = model.value
  readonly.value = true
  expect(view.state.readOnly).toBe(true)
  expect(view.state.facet(EditorView.editable)).toBe(false)
  expect(undo(view)).toBe(false)
  api.search.replace_current()
  api.search.replace_all()
  expect(model.value).toBe(snapshot)
  const from = snapshot.indexOf('alpha')
  expect(api.apply_reference_changes(snapshot, [{ from, to: from + 5, insert: 'updated' }])).toBe(true)
  expect(model.value).toContain('updated alpha')
  readonly.value = false
  expect(view.state.readOnly).toBe(false)
  expect(view.state.facet(EditorView.editable)).toBe(true)
  api.search.replace_all()
  expect(model.value).toContain('updated LOST')
  expect(boundary.views).toHaveLength(1)
})

it('mounts read-only if reference reconciliation began before the editor was ready', () => {
  const { readonly, mount } = create()
  readonly.value = true
  const view = mount()
  expect(view.state.readOnly).toBe(true)
  expect(view.state.facet(EditorView.editable)).toBe(false)
})

it('keeps pre-mount diagnostics and reference changes, then mounts the latest model', () => {
  const { api, model, mount } = create()
  expect(api.editor_ready.value).toBe(false)
  expect(api.issues.value).toEqual([])
  expect(api.validate()).toEqual([])
  const from = model.value.indexOf('alpha')
  expect(api.apply_reference_changes(model.value, [{ from, to: from + 5, insert: 'beta' }])).toBe(true)
  const view = mount()
  expect(view.state.doc.toString()).toBe(model.value)
  expect(view.state.doc.toString()).toContain('beta alpha')
  expect(api.editor_ready.value).toBe(true)
})

it('keeps a single instance across external updates and inserts with the existing newline and caret rules', async () => {
  const { api, model, mount } = create()
  const view = mount()
  model.value = 'left right'
  await nextTick()
  expect(view.state.doc.toString()).toBe('left right')
  api.insert_at_position('[a](att://a.txt)', 5)
  expect(model.value).toBe('left \n[a](att://a.txt)\nright')
  expect(view.state.selection.main.from).toBe(model.value.indexOf('right'))
  expect(api.position_at_coords({ x: 0, y: 0 })).toBe(view.state.selection.main.from)
  expect(view.focus).toHaveBeenCalledOnce()
  await nextTick()
  expect(boundary.views).toHaveLength(1)
})

it('applies reference changes outside undo history and rejects stale or disposed callbacks', async () => {
  const fixture = create()
  const { api, model } = fixture
  model.value = 'old'
  const view = fixture.mount()
  api.insert_at_position('typed', 3)
  const snapshot = model.value
  expect(api.apply_reference_changes('stale', [{ from: 0, to: 3, insert: 'wrong' }])).toBe(false)
  expect(model.value).toBe(snapshot)
  expect(api.apply_reference_changes(snapshot, [{ from: 0, to: 3, insert: 'new' }])).toBe(true)
  expect(undo(view)).toBe(true)
  expect(model.value).toBe('new')
  fixture.unmount()
  expect(api.apply_reference_changes('new', [{ from: 0, to: 3, insert: 'late' }])).toBe(false)
  api.insert_at_position('late', 0)
  await nextTick()
  expect(model.value).toBe('new')
  expect(api.position_at_coords({ x: 0, y: 0 })).toBeNull()
  expect(api.validate()).toEqual([])
  expect(view.destroy).toHaveBeenCalledOnce()
})

it('uses current reference sources for synchronous save diagnostics', async () => {
  const fixture = create()
  fixture.model.value += '\n[资料](att://资料)\n'
  fixture.mount()
  const before = fixture.api.validate()
  expect(before.some(item => item.message.includes('资料'))).toBe(true)
  fixture.folders.value = ['资料']
  await nextTick()
  expect(fixture.api.validate().some(item => item.message.includes('资料'))).toBe(false)
})

it('preserves search shortcuts, results and mode-switch closing without replacing the view', async () => {
  const { api, mode, mount } = create()
  const view = mount()
  const shortcut = view.state.facet(keymap).flat().find(binding => binding.key === 'Mod-f')!
  expect(shortcut.run!(view)).toBe(true)
  api.search.query = 'alpha'
  await nextTick()
  expect(api.search.match_count).toBe(2)
  api.search.replace = 'beta'
  api.search.replace_all()
  expect(view.state.doc.toString()).toContain('beta beta')
  mode.value = 'preview'
  await nextTick()
  expect(api.search.open).toBe(false)
  expect(boundary.views).toHaveLength(1)
})

it('reconfigures the theme in place and detaches scrolling before destroying the view', async () => {
  const fixture = create()
  const view = fixture.mount()
  expect(view.state.facet(EditorView.darkTheme)).toBe(false)
  theme.value = 'dark'
  fixture.fullscreen.value = true
  await nextTick()
  await nextTick()
  expect(view.state.facet(EditorView.darkTheme)).toBe(true)
  const spy = vi.spyOn(window_target, 'addEventListener')
  fixture.unmount()
  expect(boundary.lifecycle).toEqual(['detach', 'destroy'])
  expect(fixture.api.editor_ready.value).toBe(false)
  await nextTick()
  expect(spy).not.toHaveBeenCalled()
})

it.each(['unmount', 'leave-fullscreen'] as const)('does not reattach a pending fullscreen continuation after %s', async (action) => {
  const fixture = create()
  fixture.mount()
  await nextTick()
  const pending: (() => void)[] = []
  vi.stubGlobal('nextTick', () => new Promise<void>(resolve => pending.push(resolve)))
  const add = vi.spyOn(window_target, 'addEventListener')
  fixture.fullscreen.value = true
  await nextTick()
  expect(pending).toHaveLength(1)
  if (action === 'unmount')
    fixture.unmount()
  else
    fixture.fullscreen.value = false
  await nextTick()
  pending.forEach(resolve => resolve())
  await nextTick()
  expect(add).not.toHaveBeenCalled()
})
