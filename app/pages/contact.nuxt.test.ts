import { mountSuspended } from '@nuxt/test-utils/runtime'
import { expect, it } from 'vitest'
import ContactPage from './contact.vue'

it('shows how to reach the group and leads back to the home page', async () => {
  const wrapper = await mountSuspended(ContactPage)
  expect(wrapper.get('h1').text()).toBe('联系我们')
  // The page must carry an actual contact; at present that is a QQ number.
  expect(wrapper.text()).toMatch(/QQ\D*\d{5,}/)
  expect(wrapper.get('a[href="/"]').text()).toBe('返回主页')
  wrapper.unmount()
})
