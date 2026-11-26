import type { EditorState, Transaction, TransactionSpec } from '@codemirror/state'
import type { ViewUpdate } from '@codemirror/view'
import type { ContentStoryAttachment, ContentStorySummary } from '@shared/types/content'
import { completionStatus, startCompletion } from '@codemirror/autocomplete'
import { undo } from '@codemirror/commands'
import { EditorView, keymap } from '@codemirror/view'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { computed, effectScope, nextTick, reactive, ref, watch } from 'vue'
import { useStoryEditor } from './editor'

const boundary = vi.hoisted(() => ({ views: [] as unknown[], lifecycle: [] as string[] }))
// Only the DOM view is replaced. Transactions, history, extensions, search,
// lint, Vue watchers and the scroll-sync owner run their real implementations.
vi.mock('@codemirror/view', async (original) => {
  const actual = await original<typeof import('@codemirror/view')>()
  class TestView {
    state: EditorState
    contentDOM = new EventTarget()
    scrollDOM = Object.assign(new EventTarget(), { scrollTop: 0, scrollLeft: 0, scrollHeight: 3000, clientHeight: 400, scrollWidth: 800, clientWidth: 500 })
    focus = vi.fn()
    requestMeasure = vi.fn((request?: { read: (view: EditorView) => unknown, write?: (value: unknown, view: EditorView) => void }) => {
      if (request) {
        const self = this as unknown as EditorView
        request.write?.(request.read(self), self)
      }
    })

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
      const update = { view: this, startState, state: this.state, transactions: [transaction], changes: transaction.changes, docChanged: transaction.docChanged } as unknown as ViewUpdate
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
  window_target = Object.assign(new EventTarget(), { scrollX: 0, scrollY: 0, scrollTo: vi.fn() })
  vi.stubGlobal('document', Object.assign(new EventTarget(), { activeElement: null, visibilityState: 'visible', hasFocus: () => true }))
  const remove = window_target.removeEventListener.bind(window_target)
  vi.spyOn(window_target, 'removeEventListener').mockImplementation((... args) => {
    if (args[0] === 'resize')
      boundary.lifecycle.push('detach')
    remove(... args)
  })
  for (const [name, value] of Object.entries({ ref, computed, reactive, watch, nextTick, window: window_target }))
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
  const allow_write = ref(true)
  const write_guard = vi.fn(() => allow_write.value)
  const history_key = ref(0)
  const attachments = ref<ContentStoryAttachment[]>([])
  const stories = ref<ContentStorySummary[]>([])
  const folders = ref<string[]>([])
  const on_lint = vi.fn()
  const preview = Object.assign(new EventTarget(), { querySelector: () => null }) as unknown as HTMLElement
  const api = scope.run(() => useStoryEditor({ model, host: ref(), preview_pane: ref(preview), fullscreen, mode, readonly: () => readonly.value,
    allow_write: write_guard,
    history_key: () => history_key.value,
    sources: { attachments: () => attachments.value, stories: () => stories.value, story_id: () => null, folders: () => folders.value },
    on_lint, on_files_pasted: vi.fn(),
  }))!
  let live = true
  return {
    api, model, mode, fullscreen, readonly, allow_write, write_guard, history_key, attachments, stories, folders, on_lint,
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

it('keeps the open editor when the lease changes and isolates undo from earlier writers', async () => {
  const { api, model, history_key, mount } = create()
  const view = mount()
  api.insert_at_position('before release', model.value.length)
  api.search.open_search()
  api.search.query = 'alpha'
  history_key.value ++
  await nextTick()
  expect(api.search.open).toBe(true)
  expect(api.search.query).toBe('alpha')
  expect(undo(view)).toBe(false)
  model.value = 'other editor'
  await nextTick()
  expect(undo(view)).toBe(false)
  api.insert_at_position('after acquiring', model.value.length)
  expect(undo(view)).toBe(true)
  expect(model.value).toBe('other editor')
})

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
  api.insert_at_position('[a](att://a.txt)', 4)
  expect(model.value).toBe('left\n[a](att://a.txt)\n right')
  expect(view.state.selection.main.from).toBe(model.value.indexOf(' right'))
  expect(api.position_at_coords({ x: 0, y: 0 })).toBe(view.state.selection.main.from)
  expect(view.focus).toHaveBeenCalledOnce()
  await nextTick()
  expect(boundary.views).toHaveLength(1)
})

it.each(['prefix ', '---\ncover: '])('inserts directly after an existing space in %j', (initial) => {
  const { api, model, mount } = create()
  model.value = `${initial}\nnext line`
  const view = mount()
  const text = '![](att://封面.jpg)'
  api.insert_at_position(text, initial.length)
  expect(model.value).toBe(`${initial}${text}\nnext line`)
  expect(view.state.selection.main.head).toBe(initial.length + text.length)
})

it('maps a pending folder drop through intervening edits before inserting', () => {
  const { api, model, mount } = create()
  model.value = 'before\ncover: '
  const view = mount()
  const insert = api.track_attachment_insertion(model.value.length)
  view.dispatch({ changes: { from: 0, insert: 'new line\n' } })
  insert(['![](att://images/photo.png)'])
  expect(model.value).toBe('new line\nbefore\ncover: ![](att://images/photo.png)')
  expect(view.state.selection.main.head).toBe(model.value.length)
})

it('inserts multiple attachment references as one block even after an existing space', () => {
  const { api, model, mount } = create()
  model.value = 'before after'
  mount()
  api.track_attachment_insertion(7)(['![](att://a.png)', '[](att://b.pdf)'])
  expect(model.value).toBe('before \n<carousel>\n  ![](att://a.png)\n  [](att://b.pdf)\n</carousel>\nafter')
})

it.each(['', '> ', '  '])('inserts items into an existing carousel with %j line prefixes without nesting or splitting the original reference', (prefix) => {
  const { api, model, mount } = create()
  const container = ['<carousel>', '![](att://old.png)', '</carousel>'].map(line => prefix + line).join('\n')
  model.value = prefix === '  ' ? `- list\n\n${container}` : container
  mount()
  api.track_attachment_insertion(model.value.indexOf('old.png') + 2)(['![](att://a.png)', '[](att://b.pdf)'])
  const expected = ['<carousel>', '![](att://a.png)', '[](att://b.pdf)', '![](att://old.png)', '</carousel>'].map(line => prefix + line).join('\n')
  expect(model.value).toBe(prefix === '  ' ? `- list\n\n${expected}` : expected)
})

it('keeps a single inserted attachment on its own line inside an empty carousel', () => {
  const { api, model, mount } = create()
  model.value = '<carousel>\n</carousel>'
  mount()
  api.track_attachment_insertion(model.value.indexOf('</carousel>'))(['![](att://a.png)'])
  expect(model.value).toBe('<carousel>\n![](att://a.png)\n</carousel>')
})

it.each(['', '起始 '])('keeps dropped attachments within a same-line carousel after %j', (prefix) => {
  const { api, model, mount } = create()
  model.value = `${prefix}<carousel id=inline>![](att://old.png)</carousel>`
  mount()
  api.track_attachment_insertion(model.value.indexOf('old.png') + 1)(['![](att://a.png)', '[](att://b.pdf)'])
  expect(model.value).toBe(`${prefix}<carousel id=inline>![](att://a.png) [](att://b.pdf) ![](att://old.png)</carousel>`)
})

it('fills an empty same-line carousel without changing its tags or the surrounding prose', () => {
  const { api, model, mount } = create()
  model.value = '前文 <carousel title="A > B"></carousel> 后文'
  mount()
  api.track_attachment_insertion(model.value.indexOf('</carousel>'))(['[](att://a.txt)'])
  expect(model.value).toBe('前文 <carousel title="A > B">[](att://a.txt)</carousel> 后文')
})

it('does not treat a carousel example inside a fenced code block as an existing container', () => {
  const { api, model, mount } = create()
  model.value = '```markdown\n<carousel>\n\n</carousel>\n```'
  mount()
  api.track_attachment_insertion(model.value.indexOf('\n\n') + 1)(['![](att://a.png)', '[](att://b.pdf)'])
  expect(model.value).toBe('```markdown\n<carousel>\n<carousel>\n  ![](att://a.png)\n  [](att://b.pdf)\n</carousel>\n</carousel>\n```')
})

it('inserts a landed upload at its mapped paste position and leaves continued typing focused at the current caret', () => {
  const { api, model, mount } = create()
  model.value = 'before\nafter'
  const view = mount()
  const insert = api.track_upload_insertion(model.value.indexOf('after'))
  view.dispatch({ changes: { from: 0, insert: 'prefix ' } })
  const at = model.value.indexOf('after')
  view.dispatch({ changes: { from: at, insert: 'typed ' }, selection: { anchor: at + 6 } })
  expect(insert('[](att://final.txt)')).toBe(true)
  expect(model.value).toBe('prefix before\n[](att://final.txt)\ntyped after')
  expect(view.state.selection.main.head).toBe(model.value.indexOf('after'))
  expect(view.focus).not.toHaveBeenCalled()
  expect(insert('[](att://second.txt)')).toBe(true)
  expect(model.value).toBe('prefix before\n[](att://final.txt)\n[](att://second.txt)\ntyped after')
  expect(view.state.selection.main.head).toBe(model.value.indexOf('after'))
})

it('reports missing and disposed upload insertion targets without changing the document', () => {
  const fixture = create()
  fixture.model.value = 'before\nafter'
  const insert = fixture.api.track_upload_insertion(fixture.model.value.indexOf('after'))
  expect(insert('[](att://not-ready.txt)')).toBe(false)
  expect(fixture.model.value).toBe('before\nafter')
  fixture.mount()
  expect(insert('[](att://ready.txt)')).toBe(true)
  const saved = fixture.model.value
  fixture.unmount()
  expect(insert('[](att://disposed.txt)')).toBe(false)
  expect(fixture.model.value).toBe(saved)
})

it('reports read-only and blocked uploads without losing the tracked insertion position', () => {
  const { api, model, readonly, allow_write, mount } = create()
  model.value = 'before\nafter'
  const view = mount()
  const insert = api.track_upload_insertion(model.value.indexOf('after'))
  readonly.value = true
  expect(insert('[](att://readonly.txt)')).toBe(false)
  readonly.value = false
  allow_write.value = false
  expect(insert('[](att://blocked.txt)')).toBe(false)
  expect(model.value).toBe('before\nafter')
  allow_write.value = true
  view.dispatch({ changes: { from: 0, insert: 'prefix\n' } })
  expect(insert('[](att://ready.txt)')).toBe(true)
  expect(model.value).toBe('prefix\nbefore\n[](att://ready.txt)\nafter')
})

it('reports an upload rejected by the transaction filter instead of claiming an insertion', () => {
  const { api, model, write_guard, mount } = create()
  model.value = 'before\nafter'
  mount()
  const insert = api.track_upload_insertion(model.value.indexOf('after'))
  write_guard.mockReturnValueOnce(true).mockReturnValue(false)
  expect(insert('[](att://expired.txt)')).toBe(false)
  expect(model.value).toBe('before\nafter')
  write_guard.mockReturnValue(true)
  expect(insert('[](att://ready.txt)')).toBe(true)
  expect(model.value).toBe('before\n[](att://ready.txt)\nafter')
})

it('keeps cursor and both viewport offsets after an external document replacement', async () => {
  const fixture = create()
  fixture.model.value = 'long line\n'.repeat(300)
  const view = fixture.mount()
  view.dispatch({ selection: { anchor: 45, head: 55 } })
  view.scrollDOM.scrollTop = 1400
  view.scrollDOM.scrollLeft = 40
  const saved = fixture.api.capture_position()!
  saved.preview.top = 1100
  fixture.api.restore_position(saved)
  await nextTick()
  fixture.model.value = 'replacement line\n'.repeat(300)
  await nextTick()
  await nextTick()
  expect(view.state.selection.main.anchor).toBe(45)
  expect(view.state.selection.main.head).toBe(55)
  expect(view.scrollDOM.scrollTop).toBe(1400)
  expect(view.scrollDOM.scrollLeft).toBe(40)
  expect(fixture.api.capture_position()?.preview.top).toBe(1100)
})

it('clamps a shortened replacement to the new document and scroll edge', async () => {
  const fixture = create()
  fixture.model.value = 'long line\n'.repeat(300)
  const view = fixture.mount()
  view.dispatch({ selection: { anchor: 1000 } })
  view.scrollDOM.scrollTop = 1400
  Object.assign(view.scrollDOM, { scrollHeight: 500 })
  fixture.model.value = 'short'
  await nextTick()
  await nextTick()
  expect(view.state.selection.main.head).toBe(5)
  expect(view.scrollDOM.scrollTop).toBe(100)
})

it('keeps reference-patch scroll while mapping the cursor through its changes', async () => {
  const fixture = create()
  fixture.model.value = 'old\n'.repeat(300)
  const view = fixture.mount()
  view.dispatch({ selection: { anchor: 200 } })
  view.scrollDOM.scrollTop = 800
  expect(fixture.api.apply_reference_changes(fixture.model.value, [{ from: 0, to: 3, insert: 'new-name' }])).toBe(true)
  await nextTick()
  await nextTick()
  expect(view.state.selection.main.head).toBe(205)
  expect(view.scrollDOM.scrollTop).toBe(800)
})

it('resumes typing at the live selection after a background reference edit', async () => {
  const { api, model, readonly, mount } = create()
  const view = mount()
  view.dispatch({ selection: { anchor: 20, head: 10 } })
  Object.assign(document, { activeElement: view.contentDOM, visibilityState: 'hidden' })
  readonly.value = true
  Object.assign(document, { activeElement: null })
  expect(api.apply_reference_changes(model.value, [{ from: 0, to: 0, insert: '123' }])).toBe(true)
  Object.assign(document, { visibilityState: 'visible' })
  document.dispatchEvent(new Event('visibilitychange'))
  expect(view.focus).not.toHaveBeenCalled()
  readonly.value = false
  await nextTick()
  expect(view.focus).toHaveBeenCalledOnce()
  expect(api.capture_position()).toMatchObject({ anchor: 23, head: 13 })
})

it('cancels pending focus when the user clicks elsewhere while waiting for write access', async () => {
  const { readonly, mount } = create()
  const view = mount()
  Object.assign(document, { activeElement: view.contentDOM })
  readonly.value = true
  Object.assign(document, { activeElement: null })
  document.dispatchEvent(new Event('pointerdown'))
  readonly.value = false
  await nextTick()
  expect(view.focus).not.toHaveBeenCalled()
})

it('lets user input cancel a pending restore and ignores measurements after disposal', async () => {
  const fixture = create()
  const view = fixture.mount()
  const position = fixture.api.capture_position()!
  position.editor.top = 1500
  fixture.api.restore_position(position)
  window_target.dispatchEvent(new Event('wheel'))
  view.scrollDOM.scrollTop = 300
  await nextTick()
  expect(view.scrollDOM.scrollTop).toBe(300)
  fixture.api.restore_position(position)
  fixture.unmount()
  await nextTick()
  expect(view.scrollDOM.scrollTop).toBe(300)
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
  const visible = fixture.model.value
  const invalid = fixture.api.validate('not a Front Matter document')
  expect(invalid.some(item => item.severity === 'error')).toBe(true)
  expect(fixture.model.value).toBe(visible)
  expect(fixture.api.validate(visible).some(item => item.severity === 'error')).toBe(false)
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
  startCompletion(view)
  expect(completionStatus(view.state)).toBe('pending')
  const escape = view.state.facet(keymap).flat().find(binding => binding.key === 'Escape')!
  expect(escape.run!(view)).toBe(true)
  expect(api.search.open).toBe(false)
  expect(completionStatus(view.state)).toBe('pending')
  expect(shortcut.run!(view)).toBe(true)
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
