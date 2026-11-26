import { mountSuspended } from '@nuxt/test-utils/runtime'
import { afterEach, expect, it } from 'vitest'
import RequestFailure from './RequestFailure.vue'

const wrappers: { unmount: () => void }[] = []
afterEach(() => wrappers.splice(0).forEach(wrapper => wrapper.unmount()))

it.each(['operation', 'upload'] as const)('shows a closable %s failure and preserves its explanation during retry', async (source) => {
  const field = source === 'operation' ? 'operationError' : 'uploadError'
  const first_error = `${source} failed: 400`
  const next_error = `${source} failed: 503`
  const wrapper = await mountSuspended(RequestFailure, {
    props: { visible: true, pending: false, operationError: '', uploadError: '', [field]: first_error },
    global: { stubs: { MyDialog: { props: ['visible', 'header', 'closable'], template: '<section v-if="visible" role="dialog" :aria-label="header"><slot /><slot name="footer" /></section>' } } },
  })
  wrappers.push(wrapper)
  expect(wrapper.get('[role="dialog"]').text()).toContain(first_error)
  const initial_heading = wrapper.get('[role="dialog"]').attributes('aria-label')
  expect(initial_heading).toContain(source === 'upload' ? '上传' : '操作')
  await wrapper.get('button[aria-label="关闭"]').trigger('click')
  expect(wrapper.emitted('update:visible')).toEqual([[false]])
  await wrapper.get('button[aria-label="重试"]').trigger('click')
  expect(wrapper.emitted('retry')).toEqual([[source]])
  await wrapper.setProps({ pending: true, operationError: '', uploadError: '' })
  expect(wrapper.text()).toContain(first_error)
  expect(wrapper.get('button[aria-label="重试"]').attributes('disabled')).toBeDefined()
  expect(wrapper.get('button[aria-label="关闭"]').attributes('disabled')).toBeDefined()
  await wrapper.setProps({ pending: false, [field]: next_error })
  expect(wrapper.text()).toContain(next_error)
  expect(wrapper.get('[role="dialog"]').attributes('aria-label')).toBe(initial_heading)
  const other_field = source === 'operation' ? 'uploadError' : 'operationError'
  await wrapper.setProps({ [field]: '', [other_field]: next_error })
  expect(wrapper.get('[role="dialog"]').attributes('aria-label')).not.toBe(initial_heading)
  await wrapper.setProps({ visible: false })
  expect(wrapper.find('[role="dialog"]').exists()).toBe(false)
})
