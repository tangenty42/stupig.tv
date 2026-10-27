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
    props: { resolution: { items: [issue], valid_count: 1, valid_targets: ['docs/ok.txt'] }, pending: false },
    global: { stubs: {
      MyDialog: { props: ['visible'], template: '<div v-if="visible"><slot /><slot name="footer" /></div>' },
      MyIcon: true,
      MyContentAttachmentCard: { props: ['row'], emits: ['click'], template: '<button @click="$emit(\'click\')">{{ row.data.file_name }}</button>' },
    } },
  })
  wrappers.push(wrapper)
  return wrapper
}

it('closes the dialog when resolution finishes', async () => {
  const wrapper = await open()
  expect(wrapper.text()).toContain('整批尚未执行')
  await wrapper.setProps({ resolution: null })
  expect(wrapper.text()).toBe('')
})

it.each(error_categories)('renders %s resolution choices and submits the category policy', async (category) => {
  const wrapper = await open(category)
  expect((wrapper.getComponent(Select).props('options') ?? []).map((option: { value: string }) => option.value)).toContain('skip')
  wrapper.getComponent(Select).vm.$emit('update:modelValue', 'skip')
  await wrapper.get('button[aria-label="重试"]').trigger('click')
  expect(wrapper.emitted('submit')?.at(- 1)).toEqual([{ ... error_policy_schema.parse({}), [category]: 'skip' }])
})

it('expands groups independently and resets expansion for a new resolution', async () => {
  const wrapper = await open()
  const headers = wrapper.findAll('button[aria-expanded]:not([role="treeitem"])')
  expect(headers).toHaveLength(2)
  expect(wrapper.findAll('[role="tree"]').every(tree => (tree.element as HTMLElement).style.display === 'none')).toBe(true)
  await headers[0]!.trigger('click')
  expect((wrapper.findAll('[role="tree"]')[0]!.element as HTMLElement).style.display).not.toBe('none')
  expect((wrapper.findAll('[role="tree"]')[1]!.element as HTMLElement).style.display).toBe('none')
  await wrapper.setProps({ resolution: { items: [workspace_issue('new.txt', 'name_conflict', 'TEST', '同名')], valid_count: 0 } })
  expect((wrapper.get('[role="tree"]').element as HTMLElement).style.display).toBe('none')
})

it.each(['fail', 'keep', 'discard'] as const)('handles redacted %s through the retry action', async (action) => {
  const wrapper = await open('redacted')
  wrapper.getComponent(Select).vm.$emit('update:modelValue', action)
  await wrapper.get('button[aria-label="重试"]').trigger('click')
  if (action === 'fail') {
    expect(wrapper.emitted('close')).toHaveLength(1)
    expect(wrapper.emitted('submit')).toBeUndefined()
  }
  else {
    expect(wrapper.emitted('submit')?.at(- 1)).toEqual([{ ... error_policy_schema.parse({}), redacted: action }])
  }
})

it('prevents retry and dismissal while pending', async () => {
  const wrapper = await open()
  await wrapper.setProps({ pending: true })
  await wrapper.get('button[aria-label="重试"]').trigger('click')
  await wrapper.get('button[aria-label="取消"]').trigger('click')
  expect(wrapper.emitted('submit')).toBeUndefined()
  expect(wrapper.emitted('close')).toBeUndefined()
})
