import type { PrivacyChange } from '@shared/content-workspace'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { expect, it, onTestFinished } from 'vitest'
import PrivacyConfirm from './PrivacyConfirm.vue'

it('shows all effects in one tree, including a changed empty folder and entries past 500', async () => {
  const change = (path: string, is_folder = false): PrivacyChange => ({
    path, is_folder, from: { private: false, redaction: false }, to: { private: true, redaction: false },
  })
  const private_changes = [change('docs.good/empty', true), ... Array.from({ length: 501 }, (_, index) => change(`docs.good/file-${index}.txt`))]
  const changes: PrivacyChange[] = [... private_changes, { ... change('docs.good/redaction.png'), to: { private: false, redaction: true } }]
  const wrapper = await mountSuspended(PrivacyConfirm, {
    props: { confirmation: { changes, total: changes.length, digest: 'a'.repeat(64) }, pending: false },
    global: { stubs: {
      MyDialog: { props: ['visible', 'header'], template: '<div v-if="visible"><h2>{{ header }}</h2><slot /><slot name="footer" /></div>' },
      MyContentAttachmentCard: { props: ['row'], template: '<span :data-path="row.source.path">{{ row.source.path }}</span>' },
      MyIcon: { props: ['name'], template: '<span :data-icon="name" />' },
    } },
  })
  onTestFinished(() => wrapper.unmount())
  expect(wrapper.get('h2').text()).toBe('附件状态变更确认')
  expect(wrapper.get('p').text()).toBe('操作尚未执行，请确认以下状态变化：')
  const tree = wrapper.get('[role="tree"][aria-label="附件状态变更"]')
  expect(wrapper.findAll('[role="tree"]')).toHaveLength(1)
  expect(tree.findAll('[aria-description="公开 → 机密"]')).toHaveLength(private_changes.length)
  expect(tree.get('[data-path="docs.good/empty"]').element.closest('[role="treeitem"]')?.getAttribute('aria-expanded')).toBe('true')
  const expect_marks = (path: string, icon: string, after_color: string) => {
    const row = tree.get(`[data-path="${path}"]`).element.closest('[role="treeitem"]')!
    const marks = [... row.querySelectorAll('[data-icon]')]
    expect(marks.map(mark => mark.getAttribute('data-icon'))).toEqual([icon, 'lucide:arrow-right', icon])
    expect(marks[0]!.classList.contains('content-accent-neutral')).toBe(true)
    expect(marks[2]!.classList.contains(after_color)).toBe(true)
  }
  expect_marks('docs.good/empty', 'lucide:folder', 'content-accent-private')
  expect_marks('docs.good/file-500.txt', 'lucide:file-text', 'content-accent-private')
  expect_marks('docs.good/redaction.png', 'lucide:file-image', 'content-accent-redacted')
  await wrapper.get('button[aria-label="继续"]').trigger('click')
  expect(wrapper.emitted('confirm')).toHaveLength(1)
})
