import type { ContentStorySummary } from '@shared/types/content'
import { closeCompletion, completionStatus, startCompletion } from '@codemirror/autocomplete'
import { EditorView } from '@codemirror/view'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { referenced_attachment_keys } from '@shared/content-markdown'
import { expect, it, onTestFinished, vi } from 'vitest'
import { defineComponent, h, ref } from 'vue'
import Editor from './Editor.vue'

async function focus_editor(view: EditorView) {
  // Happy DOM tracks activeElement but does not focus a native browser window.
  const has_focus = vi.spyOn(view.dom.ownerDocument, 'hasFocus').mockReturnValue(true)
  onTestFinished(() => has_focus.mockRestore())
  view.focus()
  expect(view.hasFocus).toBe(true)
  await expect.poll(() => view.dom.classList.contains('cm-focused')).toBe(true)
}

it('reports failed refreshes alongside cached and other usable suggestions, and clears recovered status', async () => {
  const doc = '---\ntitle: Test\n---\n\n@'
  const wrapper = await mountSuspended(Editor, {
    attachTo: document.body,
    props: {
      modelValue: doc,
      storiesFailure: 'refresh',
      stories: [{
        id: 2, title: '已读档案', labels: [], event_precision: 'day', event_dates: [],
        created_at: '', updated_at: '', desc: null, cover: null, cover_label: null, cover_version: null, cover_url: null,
      } satisfies ContentStorySummary],
      attachments: [{ file_name: 'note.txt', mime_type: 'text/plain', file_size: 1, version: 'v1', url: '/note.txt', is_image: false }],
    },
    global: { stubs: { MyIcon: true, MyContentMarkdownPreview: true } },
  })
  onTestFinished(() => wrapper.unmount())
  await expect.poll(() => wrapper.find('.cm-editor').exists()).toBe(true)
  const view = EditorView.findFromDOM(wrapper.get<HTMLElement>('.cm-editor').element)!
  await focus_editor(view)
  view.dispatch({ selection: { anchor: doc.length } })
  startCompletion(view)
  const status = () => view.dom.querySelector('.cm-completion-source-status')
  const list = () => view.dom.querySelector('[role="listbox"]')
  await expect.poll(() => status()?.textContent).toBe('档案列表更新失败')
  expect(status()?.getAttribute('role')).toBe('status')
  await expect.poll(() => list()?.textContent).toContain('note.txt')
  expect(list()?.textContent).toContain('已读档案')
  expect(list()?.textContent).not.toContain('列表更新失败')

  await wrapper.setProps({ attachmentsFailure: 'refresh' })
  await expect.poll(() => status()?.textContent).toBe('档案列表更新失败\n附件列表更新失败')
  expect(list()?.textContent).toContain('note.txt')
  view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }))
  expect(status()).toBeNull()
  expect(list()).toBeNull()
  view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }))
  await expect.poll(() => status()?.textContent).toContain('档案列表更新失败')
  await expect.poll(() => list()?.textContent).toContain('note.txt')

  await wrapper.setProps({ storiesFailure: undefined, attachmentsFailure: undefined })
  await expect.poll(status).toBeNull()
  expect(list()?.textContent).toContain('note.txt')
})

it('keeps successful no-match completion closed and separately identifies a failed source', async () => {
  const doc = '---\ntitle: Test\n---\n\n@missing'
  const wrapper = await mountSuspended(Editor, {
    attachTo: document.body,
    props: { modelValue: doc },
    global: { stubs: { MyIcon: true, MyContentMarkdownPreview: true } },
  })
  onTestFinished(() => wrapper.unmount())
  await expect.poll(() => wrapper.find('.cm-editor').exists()).toBe(true)
  const view = EditorView.findFromDOM(wrapper.get<HTMLElement>('.cm-editor').element)!
  await focus_editor(view)
  view.dispatch({ selection: { anchor: doc.length } })
  startCompletion(view)
  await expect.poll(() => completionStatus(view.state)).toBeNull()
  expect(view.dom.querySelector('[role="listbox"]')).toBeNull()
  expect(view.dom.querySelector('.cm-completion-source-status')).toBeNull()
  await wrapper.setProps({ attachmentsFailure: 'load' })
  await expect.poll(() => view.dom.querySelector('.cm-completion-source-status')?.textContent).toBe('附件来源暂不可用')
  expect(view.dom.querySelector('[role="listbox"]')).toBeNull()
})

it('reopens a dismissed completion with Ctrl+Shift+Space', async () => {
  const doc = '---\ntitle: Test\ntime: 2026/11/22\n---\n\n@'
  const wrapper = await mountSuspended(Editor, {
    attachTo: document.body,
    props: {
      modelValue: doc,
      attachments: [{ file_name: 'note.txt', mime_type: 'text/plain', file_size: 1, version: 'v1', url: '/note.txt', is_image: false }],
    },
    global: { stubs: { MyIcon: true, MyContentMarkdownPreview: true } },
  })
  onTestFinished(() => wrapper.unmount())
  await expect.poll(() => wrapper.find('.cm-editor').exists()).toBe(true)
  const view = EditorView.findFromDOM(wrapper.get<HTMLElement>('.cm-editor').element)!
  view.focus()
  view.dispatch({ selection: { anchor: doc.length } })
  const list = () => view.dom.querySelector('[role="listbox"]')
  startCompletion(view)
  await expect.poll(() => list()?.textContent).toContain('note.txt')
  closeCompletion(view)
  expect(list()).toBeNull()
  view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }))
  await expect.poll(() => list()?.textContent).toContain('note.txt')
})

it('refreshes the unused hints for the full version and redaction in an open completion list', async () => {
  const redaction = { file_name: 'note.txt', mime_type: 'text/plain', file_size: 1, version: 'v1', url: '/note.txt', is_image: false, is_redaction: true }
  const full = { ... redaction, file_name: 'note.txt.good', url: '/note.txt.good', is_redaction: false, is_private: true, has_redacted: true }
  const reference = '[](att://note.txt.good)'
  const doc = `---\ntitle: Test\ntime: 2026/11/22\n---\n\n${reference}\n\n@`
  const host = defineComponent({
    setup() {
      const model = ref(doc)
      return () => h(Editor, {
        'modelValue': model.value,
        'onUpdate:modelValue': (value) => { model.value = value },
        'attachments': [redaction, full],
        'referencedPaths': referenced_attachment_keys(model.value, [redaction, full], []),
      })
    },
  })
  const wrapper = await mountSuspended(host, { attachTo: document.body, global: { stubs: { MyIcon: true, MyContentMarkdownPreview: true } } })
  onTestFinished(() => wrapper.unmount())
  await expect.poll(() => wrapper.find('.cm-editor').exists()).toBe(true)
  const view = EditorView.findFromDOM(wrapper.get<HTMLElement>('.cm-editor').element)!
  view.dispatch({ selection: { anchor: doc.length } })
  startCompletion(view)
  const list = () => view.dom.querySelector('[role="listbox"]')
  const markers = () => [redaction, full].map(({ file_name }) => list()?.querySelector<HTMLElement>(`[data-attachment-usage-key="${file_name}"]`)?.hidden)
  await expect.poll(markers).toEqual([true, true])
  const list_id = list()?.id
  view.dispatch({ changes: { from: doc.indexOf(reference), to: doc.indexOf(reference) + reference.length } })
  await expect.poll(markers).toEqual([false, false])
  expect(list()?.id).toBe(list_id)
})
