import { mountSuspended } from '@nuxt/test-utils/runtime'
import { afterEach, expect, it } from 'vitest'
import DeleteImpact from './DeleteImpact.vue'

const wrappers: { unmount: () => void }[] = []
afterEach(() => wrappers.splice(0).forEach(wrapper => wrapper.unmount()))

async function open() {
  const wrapper = await mountSuspended(DeleteImpact, {
    props: { visible: true, impact: null, draftChecked: true },
    global: { stubs: { MyDialog: { props: ['visible', 'header'], template: '<div v-if="visible" :data-header="header"><slot /><slot name="footer" /></div>' }, MyIcon: { props: ['name'], template: '<span :data-icon="name" />' } } },
  })
  wrappers.push(wrapper)
  return wrapper
}

it('shows both reference sources and confirms when impact is available', async () => {
  const wrapper = await open()
  expect(wrapper.text()).toContain('尚未删除，请核对受影响的引用：')
  await wrapper.setProps({ impact: { targets: [{ path: 'docs/a', kind: 'file' }], sources: [{ story_id: 1, title: '档案甲', references: [{ target: 'docs/a', line: 4, effect: 'missing' }] }], cloud_draft_references: true }, draft: [{ target: 'docs', line: 7, effect: 'contents' }] })
  expect(wrapper.get('[data-header]').attributes('data-header')).toBe('空城计？')
  // Attachment deletes check one story only, so its title is omitted.
  expect(wrapper.get('section[aria-label="正文引用"]').text()).toContain('第 4 行')
  expect(wrapper.text()).not.toContain('档案甲')
  expect(wrapper.text()).not.toContain('docs/a')
  const draft = wrapper.get('section[aria-label="草稿引用"]')
  expect(draft.text()).toContain('有引用')
  expect(draft.text()).toContain('当前未保存的修改')
  expect(draft.text()).toContain('第 7 行')
  expect(wrapper.findAll('section')).toHaveLength(2)
  expect(wrapper.find('button[aria-label="仍然删除"] [data-icon="lucide:check"]').exists()).toBe(true)
  await wrapper.get('button[aria-label="仍然删除"]').trigger('click')
  expect(wrapper.emitted('confirm')).toHaveLength(1)
})

it('lists each referencing story with its lines and cover when deleting a story', async () => {
  const wrapper = await open()
  await wrapper.setProps({ impact: { targets: [{ path: '甲', kind: 'story' }], sources: [
    { story_id: 2, title: '档案乙', references: [{ target: '甲', line: 30, effect: 'missing' }, { target: '甲', line: 12, effect: 'missing' }, { target: '甲', line: 0, effect: 'missing' }] },
    { story_id: 3, title: '档案丙', references: [{ target: '甲', line: 5, effect: 'missing' }, { target: '甲', line: 5, effect: 'missing' }] },
  ] } })
  const items = wrapper.findAll('li')
  expect(items.map(item => item.get('a').text())).toEqual(['档案乙', '档案丙'])
  expect(items[0]!.get('span.text-xs').text()).toBe('第 12 行等、封面')
  expect(items[1]!.get('span.text-xs').text()).toBe('第 5 行')
  const link = items[0]!.get('a.link')
  expect(link.attributes('href')).toBe('/content/2')
  expect(link.attributes('target')).toBe('_blank')
  expect(link.findAll('[data-icon]').map(icon => icon.attributes('data-icon'))).toEqual(['lucide:book-open'])
})

it('requires impact before enabling deletion', async () => {
  const wrapper = await open()
  expect(wrapper.find('[role="status"]').exists()).toBe(false)
  expect(wrapper.get('button[aria-label="仍然删除"]').attributes('disabled')).toBeDefined()
  await wrapper.get('button[aria-label="仍然删除"]').trigger('click')
  expect(wrapper.emitted('confirm')).toBeUndefined()
})

it('shows only the applicable reference notice, or a scoped empty result', async () => {
  const wrapper = await open()
  const impact = { targets: [], sources: [] }
  await wrapper.setProps({ impact })
  expect(wrapper.find('section').exists()).toBe(false)
  expect(wrapper.find('[data-icon="lucide:circle-check"]').exists()).toBe(true)
  expect(wrapper.text()).toContain('未保存的修改')
  await wrapper.setProps({ draftChecked: false })
  expect(wrapper.text()).not.toContain('未保存的修改')
  await wrapper.setProps({ draftChecked: true })
  await wrapper.setProps({ draft: [{ target: 'a', line: 1, effect: 'missing' }] })
  expect(wrapper.get('section[aria-label="草稿引用"]').text()).toContain('第 1 行')
  expect(wrapper.find('section[aria-label="正文引用"]').exists()).toBe(false)
})

it('labels a finished check as a snapshot taken when the dialog opened', async () => {
  const wrapper = await open()
  const notice = () => wrapper.find('[data-icon="lucide:clock-3"] + span')
  expect(notice().exists()).toBe(false)
  await wrapper.setProps({ impact: { targets: [], sources: [] } })
  expect(notice().text()).toContain('打开此框时')
})
