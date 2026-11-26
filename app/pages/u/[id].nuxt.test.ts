import { mountSuspended } from '@nuxt/test-utils/runtime'
import { expect, it, onTestFinished, vi } from 'vitest'
import { nextTick, ref } from 'vue'
import ProfilePage from './[id].vue'

const { account_profile } = vi.hoisted(() => ({ account_profile: vi.fn() }))
vi.mock('~/features/account/profile', () => ({ useAccountProfile: account_profile }))

it('gives loading, retryable failure and a missing user distinct views', async () => {
  const loading = ref(true)
  const failed = ref(false)
  const missing = ref(false)
  const refresh = vi.fn(async () => {
    failed.value = false
    missing.value = true
  })
  account_profile.mockReturnValue({
    profile: ref(null), loading, failed, missing,
    is_operating_other: ref(false), is_viewing_other: ref(false),
    ready: Promise.resolve({ refresh }),
  })
  const page = await mountSuspended(ProfilePage, { route: '/u/7', global: { stubs: { MyIcon: true } } })
  onTestFinished(() => page.unmount())
  expect(page.find('[role="status"][aria-label="正在加载用户资料"]').exists()).toBe(true)

  loading.value = false
  failed.value = true
  await nextTick()
  expect(page.text()).not.toContain('用户不存在')
  await page.get('button[aria-label="重新加载"]').trigger('click')
  expect(refresh).toHaveBeenCalledOnce()
  expect(page.find('button[aria-label="重新加载"]').exists()).toBe(false)
  expect(page.text()).toContain('用户不存在')
  expect(page.get('a[href="/"]').text()).toBe('返回首页')
})
