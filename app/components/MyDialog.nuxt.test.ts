import { mountSuspended } from '@nuxt/test-utils/runtime'
import { DOMWrapper } from '@vue/test-utils'
import { expect, it, onTestFinished } from 'vitest'
import MyDialog from './MyDialog.vue'

function dismiss_with_escape() {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }))
}

async function dismiss_with_mask(body: DOMWrapper<HTMLElement>) {
  const mask = body.get('.p-dialog-mask')
  await mask.trigger('mousedown')
  await mask.trigger('mouseup')
}

it.each(['Escape', 'mask', 'close button'] as const)('blocks dismissal during a submission and restores %s after it finishes', async (method) => {
  const wrapper = await mountSuspended(MyDialog, {
    props: { visible: false, pending: true, header: '测试弹窗' },
    attachTo: document.body,
    global: { stubs: { transition: false } },
  })
  onTestFinished(() => wrapper.unmount())
  const body = new DOMWrapper(document.body)
  const close_button = '[role="dialog"] button'

  await wrapper.setProps({ visible: true })
  expect(body.find(close_button).exists()).toBe(false)
  await dismiss_with_mask(body)
  dismiss_with_escape()
  expect(wrapper.emitted('update:visible')).toBeUndefined()

  await wrapper.setProps({ pending: false })
  switch (method) {
    case 'Escape':
      dismiss_with_escape()
      break
    case 'mask':
      await dismiss_with_mask(body)
      break
    case 'close button':
      await body.get(close_button).trigger('click')
      break
  }
  expect(wrapper.emitted('update:visible')).toEqual([[false]])
})

it('honors an explicit dismissal lock and lets the parent close during submission', async () => {
  const wrapper = await mountSuspended(MyDialog, {
    props: { visible: false, closable: false, header: '测试弹窗' },
    attachTo: document.body,
    global: { stubs: { transition: false } },
  })
  onTestFinished(() => wrapper.unmount())
  const body = new DOMWrapper(document.body)

  await wrapper.setProps({ visible: true })
  expect(body.find('[role="dialog"] button').exists()).toBe(false)
  await dismiss_with_mask(body)
  dismiss_with_escape()
  expect(wrapper.emitted('update:visible')).toBeUndefined()

  await wrapper.setProps({ closable: true, pending: true })
  expect(body.find('[role="dialog"] button').exists()).toBe(false)
  await wrapper.setProps({ visible: false })
  await expect.poll(() => body.find('[role="dialog"]').exists()).toBe(false)
})
