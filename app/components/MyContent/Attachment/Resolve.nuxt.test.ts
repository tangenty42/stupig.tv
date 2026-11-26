import { mountSuspended } from '@nuxt/test-utils/runtime'
import { error_categories, error_policy_schema, workspace_issue } from '@shared/content-workspace'
import Select from 'primevue/select'
import { afterEach, expect, it } from 'vitest'
import Resolve from './Resolve.vue'

const wrappers: { unmount: () => void }[] = []
afterEach(() => wrappers.splice(0).forEach(wrapper => wrapper.unmount()))
async function open(category: typeof error_categories[number] = 'name_conflict') {
  const issue = workspace_issue('docs/photo.png', category, 'TEST', '具体原因')
  const wrapper = await mountSuspended(Resolve, {
    props: { resolution: { items: [issue], valid_count: 1 }, pending: false },
    global: { stubs: {
      MyDialog: { props: ['visible'], template: '<div v-if="visible" role="dialog"><slot /><slot name="footer" /></div>' },
      MyIcon: { props: ['name'], template: '<span :data-icon="name" />' },
      MyContentAttachmentCard: { props: ['row'], emits: ['click'], template: '<button :data-path="row.source.path" :data-error="row.state.error || undefined" @click="$emit(\'click\')">{{ row.data.file_name }}</button>' },
    } },
  })
  wrappers.push(wrapper)
  return wrapper
}

it('closes the dialog when resolution finishes', async () => {
  const wrapper = await open()
  expect(wrapper.find('[role="dialog"]').exists()).toBe(true)
  await wrapper.setProps({ resolution: null })
  expect(wrapper.find('[role="dialog"]').exists()).toBe(false)
})

it.each(error_categories)('renders %s resolution choices and submits the category policy', async (category) => {
  const wrapper = await open(category)
  expect(wrapper.getComponent(Select).props('size')).toBe('small')
  expect((wrapper.getComponent(Select).props('options') ?? []).map((option: { value: string }) => option.value)).toContain('skip')
  wrapper.getComponent(Select).vm.$emit('update:modelValue', 'skip')
  await wrapper.get('button[aria-label="提交"]').trigger('click')
  expect(wrapper.emitted('submit')?.at(- 1)).toEqual([{ ... error_policy_schema.parse({}), [category]: 'skip' }])
})

it('lists only the conflicting items, never a valid-items section', async () => {
  const wrapper = await open()
  expect(wrapper.get('[role="dialog"] p').text()).toBe('操作尚未执行，请处理以下冲突：')
  expect(wrapper.get('button[aria-label="提交"] [data-icon]').attributes('data-icon')).toBe('lucide:check')
  expect(wrapper.text()).not.toContain('无错误')
  expect(wrapper.findAll('[role="tree"]')).toHaveLength(1)
  expect(wrapper.get('[role="tree"][aria-label="名称冲突"]')).toBeTruthy()
})

it('opens all groups and folders by default and resets manual folds for a new resolution', async () => {
  const wrapper = await open()
  const headers = wrapper.findAll('button[aria-expanded]:not([role="treeitem"])')
  const conflict_tree = wrapper.get('[role="tree"][aria-label="名称冲突"]')
  expect(headers).toHaveLength(1)
  expect(headers[0]!.attributes('aria-expanded')).toBe('true')
  expect((conflict_tree.element as HTMLElement).style.display).not.toBe('none')
  expect(conflict_tree.get('[data-path="docs/photo.png"]').isVisible()).toBe(true)
  await headers[0]!.trigger('click')
  expect(headers[0]!.attributes('aria-expanded')).toBe('false')
  expect((conflict_tree.element as HTMLElement).style.display).toBe('none')
  await headers[0]!.trigger('click')
  await conflict_tree.get('[data-path="docs"]').trigger('click')
  expect(conflict_tree.find('[data-path="docs/photo.png"]').exists()).toBe(false)
  await wrapper.setProps({ resolution: { items: [workspace_issue('docs/new.txt', 'name_conflict', 'TEST', '同名')], valid_count: 0 } })
  const next_tree = wrapper.get('[role="tree"]')
  expect((next_tree.element as HTMLElement).style.display).not.toBe('none')
  expect(next_tree.get('[data-path="docs/new.txt"]').isVisible()).toBe(true)
})

it.each(['fail', 'keep', 'discard'] as const)('handles redacted %s through the retry action', async (action) => {
  const wrapper = await open('redacted')
  wrapper.getComponent(Select).vm.$emit('update:modelValue', action)
  await wrapper.get('button[aria-label="提交"]').trigger('click')
  if (action === 'fail') {
    expect(wrapper.emitted('close')).toHaveLength(1)
    expect(wrapper.emitted('submit')).toBeUndefined()
  }
  else {
    expect(wrapper.emitted('submit')?.at(- 1)).toEqual([{ ... error_policy_schema.parse({}), redacted: action }])
  }
})

it('shows only this round’s conflicting targets under their own reason in an uploaded folder', async () => {
  const wrapper = await open()
  const items = [
    { ... workspace_issue('album/a.txt', 'name_conflict', 'TEST', '同名'), group: 'album' },
    { ... workspace_issue('album/bad:x.txt', 'invalid_name', 'TEST', '含非法字符'), group: 'album' },
  ]
  // Older receipts can still contain sibling paths; they must not reach the tree.
  const resolution = { items, valid_count: 0, group_targets: ['album/ok.txt', 'album/a.txt', 'album/bad:x.txt'] }
  await wrapper.setProps({ resolution })
  expect(wrapper.find('[data-path="album/ok.txt"]').exists()).toBe(false)
  expect(wrapper.get('[role="tree"][aria-label="名称冲突"]').findAll('[data-path]').map(row => row.attributes('data-path'))).toEqual(['album', 'album/a.txt'])
  expect(wrapper.get('[role="tree"][aria-label="含非法字符"]').findAll('[data-path]').map(row => row.attributes('data-path'))).toEqual(['album', 'album/bad:x.txt'])
  expect(wrapper.findAll('button[data-error]').map(card => card.attributes('data-path'))).toEqual(['album/a.txt', 'album/bad:x.txt'])
})

it('prevents retry and dismissal while pending', async () => {
  const wrapper = await open()
  await wrapper.setProps({ pending: true })
  await wrapper.get('button[aria-label="提交"]').trigger('click')
  await wrapper.get('button[aria-label="取消"]').trigger('click')
  expect(wrapper.emitted('submit')).toBeUndefined()
  expect(wrapper.emitted('close')).toBeUndefined()
})
