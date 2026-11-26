import type { ContentDeleteImpact } from '@shared/types/content-delete-impact'
import type { ContentDraftSnapshot, DraftCommand, DraftResult } from '@shared/types/content-draft'
import type { LintListItem } from '~/features/content/markdown/editor/lint'
import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { settings } from '@shared/settings'
import { DOMWrapper, flushPromises } from '@vue/test-utils'
import { expect, it, onTestFinished, vi } from 'vitest'
import { defineComponent, nextTick, ref } from 'vue'
import { useContentDraftStore } from '~/features/content/draft.store'
import EditPage from './edit.vue'

const { draft_api, start_uploads, draft_startup } = vi.hoisted(() => ({
  draft_api: vi.fn(), start_uploads: vi.fn(), draft_startup: { enabled: false },
}))
const toast = vi.hoisted(() => ({ ok: vi.fn(), error: vi.fn(), info: vi.fn() }))
mockNuxtImport('useAuth', () => () => ({ user: ref({ id: 1, is_admin: true, permissions: [] }) }))
mockNuxtImport('useApi', () => () => ({ content: draft_api() ?? {} }))
mockNuxtImport('useMyToast', () => () => toast)
mockNuxtImport('useSyncedData', () => async (_resource: unknown, fetcher: () => Promise<unknown>, options?: { query_key?: string }) => ({
  refresh: async () => {
    if (draft_startup.enabled && options?.query_key === 'draft-keepalive')
      await fetcher()
  },
}))
vi.mock('~/features/content/attachments/panel', () => ({
  useAttachmentPanel: () => ({ rows: [], uploads: { finalizing: new Set(), preparations: [], admitting: false }, catalog: { data: ref(null), loading: ref(false), error: ref(null), active: true }, start: start_uploads, ready: Promise.resolve() }),
}))

it('fades the connecting state out before the draft editor enters', async () => {
  const entered = vi.fn()
  const wrapper = await mountSuspended(EditPage, {
    route: '/content/43/edit',
    attachTo: document.body,
    global: { stubs: {
      transition: false,
      MyContentMarkdownEditor: defineComponent({
        name: 'ReadyEditor',
        template: '<section />',
        mounted() {
          entered((this.$el as HTMLElement).closest('.site-page-enter-active') !== null)
        },
      }),
      MyHeightSection: { template: '<section><slot /></section>' },
      MyContentStoryHeader: true, MyContentAttachmentWorkspace: true, MyContentDeleteImpact: true, MyIcon: true,
    } },
  })
  try {
    const loading = wrapper.get('[role="status"]')
    expect(loading.text()).toContain('正在连接云端草稿')
    const store = useContentDraftStore(43)
    store.cloud = { id: 'e'.repeat(32), story_id: 43, markdown: '正文', draft_revision: 1, namespace_revision: 0, title_revision: 0,
      published_main_revision: 1, unpublished_changes: false, lease_epoch: 1, occupied: true, owned: true, lease_remaining_ms: 23000, updated_at: '', channel: 'draft' }
    await nextTick()
    expect(loading.classes()).toContain('site-page-leave-active')
    expect(wrapper.findComponent({ name: 'ReadyEditor' }).exists()).toBe(false)
    await vi.waitFor(() => expect(wrapper.findComponent({ name: 'ReadyEditor' }).exists()).toBe(true))
    expect(wrapper.find('[role="status"]').exists()).toBe(false)
    expect(entered).toHaveBeenCalledWith(true)

    store.clear()
    await nextTick()
    await nextTick()
    expect(wrapper.findComponent({ name: 'ReadyEditor' }).exists()).toBe(false)
    expect(document.body.querySelector('.site-page-leave-active')).toBeNull()
    expect(wrapper.get('[role="status"]').text()).toContain('正在连接云端草稿')
  }
  finally {
    wrapper.unmount()
  }
})

it('replaces the connecting spinner with retry after startup fails and opens the editor on success', async () => {
  const snapshot: ContentDraftSnapshot = {
    id: 'f'.repeat(32), story_id: 47, markdown: '---\ntitle: 档案\n---\n云端正文', draft_revision: 1,
    namespace_revision: 0, title_revision: 0, published_main_revision: 1, unpublished_changes: false,
    lease_epoch: 0, occupied: true, owned: false, lease_remaining_ms: 23000, updated_at: '', channel: 'draft',
  }
  const get_draft = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ snapshot })
  toast.error.mockClear()
  draft_api.mockReturnValue({ get_draft })
  draft_startup.enabled = true
  onTestFinished(() => {
    draft_startup.enabled = false
    draft_api.mockReset()
  })
  const wrapper = await mountSuspended(EditPage, {
    route: '/content/47/edit',
    global: { stubs: {
      MyContentMarkdownEditor: { name: 'RecoveredEditor', template: '<section />' },
      MyContentStoryHeader: true, MyContentAttachmentWorkspace: true, MyContentDeleteImpact: true, MyIcon: true,
    } },
  })
  onTestFinished(() => wrapper.unmount())
  const retry_button = 'button[aria-label="重新加载"]'
  await vi.waitFor(() => expect(wrapper.find(retry_button).exists()).toBe(true))
  expect(wrapper.text()).not.toContain('正在连接云端草稿')
  expect(toast.error).toHaveBeenCalledExactlyOnceWith('云端草稿加载失败，请重试')

  await wrapper.get(retry_button).trigger('click')
  await vi.waitFor(() => expect(wrapper.findComponent({ name: 'RecoveredEditor' }).exists()).toBe(true))
  expect(wrapper.find(retry_button).exists()).toBe(false)
})

it('keeps a pending file selection and paste name when the same page reacquires an unchanged draft', async () => {
  const wrapper = await mountSuspended(EditPage, {
    route: '/content/7/edit',
    attachTo: document.body,
    global: { stubs: {
      MyContentMarkdownEditor: { name: 'PasteEditor', emits: ['files-pasted'], template: '<section><slot name="attachments" /></section>' },
      MyContentStoryHeader: true, MyContentDeleteImpact: true, MyContentAttachmentImageEditor: true, MyIcon: true, MyImagePreview: true,
      MyContentAttachmentRequestFailure: true, MyContentAttachmentResolve: true, MyContentAttachmentPrivacyConfirm: true,
    } },
  })
  try {
    const store = useContentDraftStore(7)
    const initial = { id: 'a'.repeat(32), story_id: 7, markdown: '正文', draft_revision: 1, namespace_revision: 0, title_revision: 0,
      published_main_revision: 1, unpublished_changes: false, lease_epoch: 1, occupied: true, owned: true, lease_remaining_ms: 23000, updated_at: '', channel: 'draft' }
    store.cloud = initial
    await nextTick()
    const editor = wrapper.getComponent({ name: 'PasteEditor' })
    const picker = editor.get<HTMLInputElement>('input[aria-label="选择上传文件"]')
    const file = new File(['text'], 'note.txt')
    editor.vm.$emit('files-pasted', [{ file, file_name: file.name }], null)
    await nextTick()
    const body = new DOMWrapper(document.body)
    const name = 'input[aria-label="附件名称"]'
    // The extension is a fixed suffix; only the stem is editable.
    expect((body.get(name).element as HTMLInputElement).value).toBe('note')
    expect(body.get('[aria-label="固定后缀"]').text()).toBe('.txt')
    await body.get(name).setValue('改名')
    store.cloud = { ... initial, occupied: false, owned: false }
    await nextTick()
    store.cloud = { ... initial, lease_epoch: 2 }
    await nextTick()
    expect((body.get(name).element as HTMLInputElement).value).toBe('改名')
    expect(wrapper.getComponent({ name: 'PasteEditor' }).get('input[aria-label="选择上传文件"]').element).toBe(picker.element)
    await body.get(name).trigger('keydown.enter')
    expect(start_uploads).toHaveBeenCalledWith([expect.objectContaining({ file, file_name: '改名.txt' })])
    Object.defineProperty(picker.element, 'files', { value: [file] })
    await picker.trigger('change')
    expect(start_uploads).toHaveBeenLastCalledWith([expect.objectContaining({ file, file_name: 'note.txt' })])

    editor.vm.$emit('files-pasted', [{ file, file_name: file.name }], null)
    await nextTick()
    const dialog = body.get('[role="dialog"][aria-label="命名"]')
    expect(dialog.find('button[aria-label="取消"]').exists()).toBe(false)
    const prior_uploads = start_uploads.mock.calls.length
    await dialog.get('.p-dialog-close-button').trigger('click')
    await expect.poll(() => body.find(name).exists()).toBe(false)
    expect(start_uploads).toHaveBeenCalledTimes(prior_uploads)

    editor.vm.$emit('files-pasted', [{ file, file_name: file.name }], null)
    await nextTick()
    store.cloud = { ... initial, lease_epoch: 3, owned: false }
    await nextTick()
    expect(body.find(name).exists()).toBe(false)
  }
  finally {
    wrapper.unmount()
  }
})

it('keeps the extension and .good marker locked while pasting a renamed image', async () => {
  const wrapper = await mountSuspended(EditPage, {
    route: '/content/7/edit',
    attachTo: document.body,
    global: { stubs: {
      MyContentMarkdownEditor: { name: 'PasteEditor', emits: ['files-pasted'], template: '<section><slot name="attachments" /></section>' },
      MyContentStoryHeader: true, MyContentDeleteImpact: true, MyContentAttachmentImageEditor: true, MyIcon: true, MyImagePreview: true,
      MyContentAttachmentRequestFailure: true, MyContentAttachmentResolve: true, MyContentAttachmentPrivacyConfirm: true,
    } },
  })
  try {
    const store = useContentDraftStore(7)
    store.cloud = { id: 'b'.repeat(32), story_id: 7, markdown: '正文', draft_revision: 1, namespace_revision: 0, title_revision: 0,
      published_main_revision: 1, unpublished_changes: false, lease_epoch: 1, occupied: true, owned: true, lease_remaining_ms: 23000, updated_at: '', channel: 'draft' }
    await nextTick()
    const editor = wrapper.getComponent({ name: 'PasteEditor' })
    const file = new File(['png'], '封面.png.good')
    editor.vm.$emit('files-pasted', [{ file, file_name: file.name }], null)
    await nextTick()
    const body = new DOMWrapper(document.body)
    const name = 'input[aria-label="附件名称"]'
    expect((body.get(name).element as HTMLInputElement).value).toBe('封面')
    expect(body.get('[aria-label="固定后缀"]').text()).toBe('.png.good')
    await body.get(name).setValue('新封面')
    await body.get(name).trigger('keydown.enter')
    expect(start_uploads).toHaveBeenLastCalledWith([expect.objectContaining({ file, file_name: '新封面.png.good' })])
  }
  finally {
    wrapper.unmount()
  }
})

it('cleans illegal characters from the pasted default stem and suffix before submitting', async () => {
  const wrapper = await mountSuspended(EditPage, {
    route: '/content/7/edit',
    attachTo: document.body,
    global: { stubs: {
      MyContentMarkdownEditor: { name: 'PasteEditor', emits: ['files-pasted'], template: '<section><slot name="attachments" /></section>' },
      MyContentStoryHeader: true, MyContentDeleteImpact: true, MyContentAttachmentImageEditor: true, MyIcon: true, MyImagePreview: true,
      MyContentAttachmentRequestFailure: true, MyContentAttachmentResolve: true, MyContentAttachmentPrivacyConfirm: true,
    } },
  })
  try {
    const store = useContentDraftStore(7)
    store.cloud = { id: 'c'.repeat(32), story_id: 7, markdown: '正文', draft_revision: 1, namespace_revision: 0, title_revision: 0,
      published_main_revision: 1, unpublished_changes: false, lease_epoch: 1, occupied: true, owned: true, lease_remaining_ms: 23000, updated_at: '', channel: 'draft' }
    await nextTick()
    const editor = wrapper.getComponent({ name: 'PasteEditor' })
    const file = new File(['png'], '屏 幕:截图.png: ')
    editor.vm.$emit('files-pasted', [{ file, file_name: file.name }], null)
    await nextTick()
    const body = new DOMWrapper(document.body)
    expect((body.get('input[aria-label="附件名称"]').element as HTMLInputElement).value).toBe('屏_幕_截图')
    expect(body.get('[aria-label="固定后缀"]').text()).toBe('.png__')
    await body.get('input[aria-label="附件名称"]').trigger('keydown.enter')
    expect(start_uploads).toHaveBeenLastCalledWith([expect.objectContaining({ file, file_name: '屏_幕_截图.png__' })])
  }
  finally {
    wrapper.unmount()
  }
})

it('unlocks recovery dismissal after the first copy attempt and preserves the text for a retry', async () => {
  const wrapper = await mountSuspended(EditPage, {
    route: '/content/7/edit',
    attachTo: document.body,
    global: { stubs: { MyContentDeleteImpact: true, MyIcon: true } },
  })
  const write = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined).mockRejectedValueOnce(new Error('Clipboard denied'))
  try {
    const store = useContentDraftStore(7)
    const body = new DOMWrapper(document.body)
    const selector = '[role="dialog"][aria-label="恢复区"]'
    const close_button = '.p-dialog-close-button'
    const markdown = '---\ntitle: 草稿\n---\n\n未上传的改动  \n第二行'
    expect(body.find(selector).exists()).toBe(false)
    store.recovery = markdown
    await nextTick()
    const dialog = body.get(selector)
    expect(dialog.get('p').text()).toBe('编辑权发生变化，当前编辑器内的内容尚未保存到云端，且关闭本弹窗后这些内容将丢失！请及时复制保存：')
    expect(dialog.find('textarea').exists()).toBe(false)
    expect(dialog.find(close_button).exists()).toBe(false)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }))
    await nextTick()
    expect(body.find(selector).exists()).toBe(true)

    const mask = body.get('.p-dialog-mask')
    await mask.trigger('mousedown')
    await mask.trigger('mouseup')
    expect(body.find(selector).exists()).toBe(true)
    expect(store.recovery).toBe(markdown)

    const copy = dialog.get('button[aria-label="复制未保存内容"]')
    toast.error.mockClear()
    toast.ok.mockClear()
    await copy.trigger('click')
    await flushPromises()
    expect(write).toHaveBeenCalledExactlyOnceWith(markdown)
    expect(toast.error).toHaveBeenCalledExactlyOnceWith('复制失败，请重试')
    expect(toast.ok).not.toHaveBeenCalled()
    expect(store.recovery).toBe(markdown)
    expect(body.find(selector).exists()).toBe(true)
    expect(dialog.find(close_button).exists()).toBe(true)

    await copy.trigger('click')
    await flushPromises()
    expect(write).toHaveBeenNthCalledWith(2, markdown)
    expect(toast.ok).toHaveBeenCalledExactlyOnceWith('已复制未保存内容')
    expect(store.recovery).toBe(markdown)
    expect(body.find(selector).exists()).toBe(true)

    await dialog.get(close_button).trigger('click')
    expect(store.recovery).toBe('')
    expect(body.find(selector).exists()).toBe(false)

    store.recovery = '第二次恢复'
    await nextTick()
    expect(body.get(selector).find(close_button).exists()).toBe(false)
  }
  finally {
    write.mockRestore()
    wrapper.unmount()
  }
})

async function mount_active_editor(get_delete_impact?: (input: { kind: 'story', id: number }) => Promise<ContentDeleteImpact>) {
  let snapshot: ContentDraftSnapshot = { id: 'd'.repeat(32), story_id: 7, markdown: '---\ntitle: 档案\n---\n云端正文',
    draft_revision: 1, namespace_revision: 0, title_revision: 0, published_main_revision: 1, unpublished_changes: false,
    lease_epoch: 0, occupied: false, owned: false, lease_remaining_ms: 23000, updated_at: '', channel: 'draft' }
  const acknowledge = (command: DraftCommand): DraftResult => {
    const owned = command.kind !== 'release'
    snapshot = {
      ... snapshot,
      owned,
      occupied: owned,
      ... (command.markdown === undefined ? {} : { markdown: command.markdown, draft_revision: snapshot.draft_revision + 1, unpublished_changes: true }),
    }
    return { snapshot, receipt: { seq: command.seq, kind: command.kind, ok: true } }
  }
  const command_draft = vi.fn(async (command: DraftCommand) => acknowledge(command))
  draft_api.mockReturnValue({
    get_draft: async () => ({ snapshot }),
    acquire_draft: async () => {
      snapshot = { ... snapshot, owned: true, occupied: true, lease_epoch: 1 }
      return { snapshot }
    },
    command_draft, get_delete_impact,
  })
  const validate = vi.fn<(_markdown: string) => LintListItem[]>(() => [])
  const wrapper = await mountSuspended(EditPage, {
    route: '/content/7/edit',
    attachTo: document.body,
    global: { stubs: {
      MyContentMarkdownEditor: { methods: { validate }, template: '<section><slot name="toolbar-start" /></section>' },
      MyContentStoryHeader: { template: '<header><slot name="actions" /></header>' },
      MyContentAttachmentWorkspace: true,
      MyIcon: true,
    } },
  })
  draft_api.mockReset()
  const store = useContentDraftStore(7)
  await store.open({ story_id: 7 })
  store.set_visible(true)
  await store.cycle()
  expect(store.writable).toBe(true)
  return { wrapper, store, command_draft, acknowledge, validate, router: wrapper.vm.$router }
}

it('shows the story delete dialog only on a successful reference check', async () => {
  const first = Promise.withResolvers<ContentDeleteImpact>()
  const second = Promise.withResolvers<ContentDeleteImpact>()
  const check = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
  toast.error.mockClear()
  const f = await mount_active_editor(check)
  try {
    const button = f.wrapper.get<HTMLButtonElement>('button[aria-label="删除"]')
    const body = new DOMWrapper(document.body)
    const dialog = '[role="dialog"][aria-label="空城计？"]'

    await button.trigger('click')
    expect(check).toHaveBeenCalledExactlyOnceWith({ kind: 'story', id: 7 })
    expect(button.element.disabled).toBe(true)
    expect(button.classes()).toContain('p-button-loading')
    expect(body.find(dialog).exists()).toBe(false)

    first.reject(new Error('Failed to fetch'))
    await flushPromises()
    expect(button.element.disabled).toBe(false)
    expect(body.find(dialog).exists()).toBe(false)
    expect(toast.error).toHaveBeenCalledExactlyOnceWith('引用检查失败，请重试后再删除')

    await button.trigger('click')
    expect(button.element.disabled).toBe(true)
    expect(body.find(dialog).exists()).toBe(false)
    second.resolve({ targets: [], sources: [] })
    await flushPromises()
    expect(button.element.disabled).toBe(false)
    expect(body.get(dialog).text()).toContain('未发现引用')
    expect(f.command_draft.mock.calls.some(([command]) => command.kind === 'delete')).toBe(false)
  }
  finally {
    f.wrapper.unmount()
  }
})

const leave_dialog = '[role="dialog"][aria-label="草稿尚未保存"]'

it('confirms the latest draft text before moving to another editor on the same route', async () => {
  const f = await mount_active_editor()
  try {
    const receipt = Promise.withResolvers<void>()
    f.command_draft.mockImplementationOnce(async (command) => {
      await receipt.promise
      return f.acknowledge(command)
    })
    f.store.markdown += '\n第一段'
    const saving = f.store.cycle()
    const navigating = f.router.push('/content/8/edit')
    await flushPromises()
    expect(f.router.currentRoute.value.path).toBe('/content/7/edit')
    f.store.markdown += '\n在途新增'
    const latest = f.store.markdown
    receipt.resolve()
    await saving
    await navigating
    expect(f.router.currentRoute.value.path).toBe('/content/8/edit')
    expect(f.command_draft.mock.calls.map(([command]) => command.kind)).toEqual(['sync', 'sync'])
    expect(f.command_draft).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'sync', markdown: latest }))
    expect(f.store.cloud?.markdown).toBe(latest)
    expect(document.querySelector(leave_dialog)).toBeNull()
  }
  finally {
    f.wrapper.unmount()
  }
  await vi.waitFor(() => expect(f.command_draft).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'release' })))
})

it('lets the editor stay after timeout and accepts a late receipt without navigating', async () => {
  const f = await mount_active_editor()
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  try {
    const receipt = Promise.withResolvers<void>()
    f.command_draft.mockImplementationOnce(async (command) => {
      await receipt.promise
      return f.acknowledge(command)
    })
    f.store.markdown += '\n本地修改'
    expect(window.dispatchEvent(new Event('beforeunload', { cancelable: true }))).toBe(false)
    const navigating = f.router.push('/content')
    await vi.waitFor(() => expect(f.command_draft).toHaveBeenCalledWith(expect.objectContaining({ kind: 'sync', markdown: f.store.markdown })))
    await vi.advanceTimersByTimeAsync(settings.app.content.draft.requestTimeoutMs)
    vi.useRealTimers()
    const body = new DOMWrapper(document.body)
    await nextTick()
    const dialog = body.get(leave_dialog)
    await dialog.get('button[aria-label="留下"]').trigger('click')
    await navigating
    expect(f.router.currentRoute.value.path).toBe('/content/7/edit')
    expect(f.store.markdown).toContain('本地修改')
    expect(f.store.writable).toBe(true)
    expect(f.command_draft.mock.calls.map(([command]) => command.kind)).toEqual(['sync'])

    receipt.resolve()
    await flushPromises()
    expect(f.store.unconfirmed_changes).toBe(false)
    expect(window.dispatchEvent(new Event('beforeunload', { cancelable: true }))).toBe(true)
    expect(f.router.currentRoute.value.path).toBe('/content/7/edit')
    await f.router.push('/content')
    expect(f.router.currentRoute.value.path).toBe('/content')
    expect(body.find(leave_dialog).exists()).toBe(false)
  }
  finally {
    vi.useRealTimers()
    f.wrapper.unmount()
  }
})

it('waits for a leave decision on failed sync and releases the draft only on actual departure', async () => {
  const f = await mount_active_editor()
  try {
    f.command_draft.mockImplementationOnce(async command => ({
      snapshot: f.store.cloud,
      receipt: { kind: command.kind, seq: command.seq, ok: false, error: 'validation_failed' },
    }))
    f.store.markdown += '\n遗留正文'
    const navigating = f.router.push('/content')
    const body = new DOMWrapper(document.body)
    await expect.poll(() => body.find(leave_dialog).exists()).toBe(true)
    expect(f.router.currentRoute.value.path).toBe('/content/7/edit')
    expect(f.store.writable).toBe(true)
    expect(f.command_draft.mock.calls.map(([command]) => command.kind)).toEqual(['sync'])
    await body.get(leave_dialog).get('button[aria-label="离开"]').trigger('click')
    await navigating
    expect(f.router.currentRoute.value.path).toBe('/content')
  }
  finally {
    f.wrapper.unmount()
  }
  await vi.waitFor(() => expect(f.command_draft).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'release', markdown: expect.stringContaining('遗留正文') })))
})

it('protects the unsaved text through a fetch failure until the server confirms it', async () => {
  const f = await mount_active_editor()
  try {
    f.command_draft.mockRejectedValue(new TypeError('Failed to fetch'))
    const markdown = `${f.store.markdown}\n断网时的本地改动`
    f.store.markdown = markdown
    await expect(f.store.flush_changes(new AbortController().signal)).rejects.toThrow('Failed to fetch')
    await nextTick()
    const pending = f.command_draft.mock.lastCall![0]
    expect(pending).toMatchObject({ kind: 'sync', markdown })
    expect(f.wrapper.text()).toContain('连接中断，修改尚未保存')
    expect(window.dispatchEvent(new Event('beforeunload', { cancelable: true }))).toBe(false)

    const navigating = f.router.push('/content')
    const body = new DOMWrapper(document.body)
    await expect.poll(() => body.find(leave_dialog).exists()).toBe(true)
    expect(f.command_draft).toHaveBeenLastCalledWith(pending)
    await body.get(leave_dialog).get('button[aria-label="留下"]').trigger('click')
    await navigating
    expect(f.router.currentRoute.value.path).toBe('/content/7/edit')
    expect(f.store.markdown).toBe(markdown)
    expect(f.store.unconfirmed_changes).toBe(true)

    f.command_draft.mockImplementation(async command => f.acknowledge(command))
    await f.store.cycle()
    expect(f.command_draft).toHaveBeenLastCalledWith(pending)
    expect(f.store.cloud?.markdown).toBe(markdown)
    expect(f.store.unconfirmed_changes).toBe(false)
    expect(window.dispatchEvent(new Event('beforeunload', { cancelable: true }))).toBe(true)
    await f.router.push('/content')
    expect(f.router.currentRoute.value.path).toBe('/content')
    expect(body.find(leave_dialog).exists()).toBe(false)
  }
  finally {
    f.wrapper.unmount()
  }
})

it('uses the same publication gate for the save button and Ctrl+S', async () => {
  const f = await mount_active_editor()
  try {
    const issue = { from: 0, to: 1, line: 1, message: '测试问题', source: 'test' }
    f.validate.mockReturnValueOnce([{ ... issue, severity: 'error' }])
    await f.wrapper.get('button[aria-label="保存"]').trigger('click')
    await vi.waitFor(() => expect(f.validate).toHaveBeenCalledWith(f.store.markdown))
    expect(f.command_draft).not.toHaveBeenCalled()

    f.validate.mockReturnValueOnce([{ ... issue, severity: 'warning' }])
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, cancelable: true }))
    await vi.waitFor(() => expect(f.command_draft).toHaveBeenCalledWith(expect.objectContaining({ kind: 'publish' })))
    expect(f.validate).toHaveBeenCalledTimes(2)
  }
  finally {
    f.wrapper.unmount()
  }
})
