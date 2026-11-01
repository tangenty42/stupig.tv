import { mountSuspended } from '@nuxt/test-utils/runtime'
import { afterEach, expect, it } from 'vitest'
import RequestFailure from './RequestFailure.vue'

const wrappers: { unmount: () => void }[] = []
afterEach(() => wrappers.splice(0).forEach(wrapper => wrapper.unmount()))

it.each(['operation', 'upload'] as const)('shows a closable %s failure and preserves its explanation during retry', async (source) => {
  const wrapper = await mountSuspended(RequestFailure, {
    props: { visible: true, operationError: source === 'operation' ? '请求参数不合法！' : '', uploadError: source === 'upload' ? '请求参数不合法！' : '', pending: false },
    global: { stubs: { MyDialog: { props: ['visible', 'header', 'closable'], template: '<section v-if="visible" role="dialog" :aria-label="header"><slot /><slot name="footer" /></section>' } } },
  })
  wrappers.push(wrapper)
  expect(wrapper.get('[role="dialog"]').attributes('aria-label')).toBe(source === 'upload' ? '上传请求失败' : '附件操作失败')
  await wrapper.get('button[aria-label="关闭"]').trigger('click')
  expect(wrapper.emitted('update:visible')).toEqual([[false]])
  await wrapper.get('button[aria-label="重试"]').trigger('click')
  expect(wrapper.emitted('retry')).toEqual([[source]])
  await wrapper.setProps({ pending: true, operationError: '', uploadError: '' })
  expect(wrapper.text()).toContain('请求参数不合法！')
  expect(wrapper.get('button[aria-label="重试"]').attributes('disabled')).toBeDefined()
  expect(wrapper.get('button[aria-label="关闭"]').attributes('disabled')).toBeDefined()
  await wrapper.setProps({ pending: false, operationError: source === 'operation' ? '连接暂不可用' : '', uploadError: source === 'upload' ? '连接暂不可用' : '' })
  expect(wrapper.text()).toContain('连接暂不可用')
  await wrapper.setProps({ visible: false })
  expect(wrapper.find('[role="dialog"]').exists()).toBe(false)
})
