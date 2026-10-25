import { mountSuspended } from '@nuxt/test-utils/runtime'
import { link_file_name_illegal_chars } from '@shared/content-markdown'
import { afterEach, expect, it } from 'vitest'
import { nextTick } from 'vue'
import MyFileNameInput from './MyFileNameInput.vue'
import MyFilteredInput from './MyFilteredInput.vue'

const wrappers: { unmount: () => void }[] = []
afterEach(() => wrappers.splice(0).forEach(wrapper => wrapper.unmount()))

async function mount_field(value = '', replacement = '_') {
  const wrapper = await mountSuspended(MyFilteredInput, {
    props: { modelValue: value, filter: link_file_name_illegal_chars, replacement },
  })
  wrappers.push(wrapper)
  return wrapper
}

it('filters the actual input even when its clean value matches the parent model', async () => {
  const wrapper = await mount_field('文件_名')
  await wrapper.get('input').setValue('文件/名')
  expect(wrapper.get('input').element.value).toBe('文件_名')
  expect(wrapper.emitted('update:modelValue')?.at(- 1)).toEqual(['文件_名'])
})

it('keeps composition text and sanitizes the actual DOM value on compositionend', async () => {
  const wrapper = await mount_field('旧值')
  const input = wrapper.get('input')
  await input.trigger('compositionstart')
  await input.setValue('中文/完成')
  expect(input.element.value).toBe('中文/完成')
  await input.trigger('compositionend')
  expect(input.element.value).toBe('中文_完成')
  expect(wrapper.emitted('update:modelValue')?.at(- 1)).toEqual(['中文_完成'])
})

it('preserves the caret when forbidden characters are removed', async () => {
  const wrapper = await mount_field('ab', '')
  const input = wrapper.get('input')
  input.element.value = '/a/b'
  input.element.setSelectionRange(3, 3)
  await input.trigger('input')
  await nextTick()
  expect(input.element.value).toBe('ab')
  expect(input.element.selectionStart).toBe(1)
})

it('renders a locked suffix separately and forwards input attributes and model events', async () => {
  const wrapper = await mountSuspended(MyFileNameInput, {
    props: { modelValue: 'photo', suffix: '.avif', disabled: true },
    attrs: { 'aria-label': '文件名' },
  })
  wrappers.push(wrapper)
  expect(wrapper.get('[aria-label="固定后缀"]').text()).toBe('.avif')
  expect(wrapper.get('input').attributes('aria-label')).toBe('文件名')
  expect(wrapper.get('input').element.disabled).toBe(true)
  await wrapper.setProps({ disabled: false })
  await wrapper.get('input').setValue('new/name')
  expect(wrapper.emitted('update:modelValue')?.at(- 1)).toEqual(['new_name'])
  expect(wrapper.get('[aria-label="固定后缀"]').text()).toBe('.avif')
})
