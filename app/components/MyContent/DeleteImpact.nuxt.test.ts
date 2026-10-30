import { mountSuspended } from '@nuxt/test-utils/runtime'
import { afterEach, expect, it } from 'vitest'
import DeleteImpact from './DeleteImpact.vue'

const wrappers: { unmount: () => void }[] = []
afterEach(() => wrappers.splice(0).forEach(wrapper => wrapper.unmount()))

async function open() {
  const wrapper = await mountSuspended(DeleteImpact, {
    props: { visible: true, description: '删除附件？', impact: null, loading: true, draftChecked: true },
    global: { stubs: { MyDialog: { props: ['visible', 'header'], template: '<div v-if="visible" :data-header="header"><slot /><slot name="footer" /></div>' }, MyIcon: { props: ['name'], template: '<span :data-icon="name" />' } } },
  })
  wrappers.push(wrapper)
  return wrapper
}

it('waits for the impact check, shows both sources, and confirms only when ready', async () => {
  const wrapper = await open()
  expect(wrapper.get('button[aria-label="仍然删除"]').attributes('disabled')).toBeDefined()
  await wrapper.setProps({ loading: false, impact: { targets: [{ path: 'docs/a', kind: 'file' }], sources: [{ story_id: 1, title: '档案甲', references: [{ target: 'docs/a', line: 4, effect: 'missing' }] }], cloud_draft_references: true }, draft: [{ target: 'docs', line: 7, effect: 'contents' }] })
  expect(wrapper.get('[data-header]').attributes('data-header')).toBe('空城计？')
  expect(wrapper.text()).toContain('有正文正在引用。')
  expect(wrapper.text()).toContain('有云端草稿正在引用。')
  expect(wrapper.text()).toContain('有未上传修改正在引用。')
  expect(wrapper.text()).not.toContain('档案甲')
  expect(wrapper.text()).not.toContain('docs/a')
  expect(wrapper.text()).not.toContain('第 4 行')
  expect(wrapper.find('button[aria-label="仍然删除"] [data-icon="lucide:check"]').exists()).toBe(true)
  await wrapper.get('button[aria-label="仍然删除"]').trigger('click')
  expect(wrapper.emitted('confirm')).toHaveLength(1)
})

it('keeps deletion disabled on failure and offers a retry', async () => {
  const wrapper = await open()
  await wrapper.setProps({ loading: false, failure: true })
  expect(wrapper.get('[role="alert"]').text()).toContain('引用检查失败')
  expect(wrapper.get('button[aria-label="仍然删除"]').attributes('disabled')).toBeDefined()
  await wrapper.get('button[aria-label="重试"]').trigger('click')
  expect(wrapper.emitted('retry')).toHaveLength(1)
  expect(wrapper.emitted('confirm')).toBeUndefined()
})

it('shows only the applicable reference notice, or a scoped empty result', async () => {
  const wrapper = await open()
  const impact = { targets: [], sources: [] }
  await wrapper.setProps({ loading: false, impact })
  expect(wrapper.text()).toContain('未发现可见正文、云端草稿或当前未上传修改的引用。')
  await wrapper.setProps({ draft: [{ target: 'a', line: 1, effect: 'missing' }] })
  expect(wrapper.text()).toContain('有未上传修改正在引用。')
  expect(wrapper.text()).not.toContain('有正文正在引用。')
})
