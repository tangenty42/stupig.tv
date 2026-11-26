import { mountSuspended } from '@nuxt/test-utils/runtime'
import { afterEach, expect, it, vi } from 'vitest'
import { nextTick, ref } from 'vue'
import App from './app.vue'

const toast = vi.hoisted(() => ({ removeAllGroups: vi.fn() }))
vi.mock('primevue/usetoast', () => ({ useToast: () => toast }))
vi.mock('~/features/account/auth', () => ({
  useAccountIdentity: () => ({ user: ref(null), ready: Promise.resolve() }),
}))

const wrappers: { unmount: () => void }[] = []
afterEach(() => {
  wrappers.splice(0).forEach(wrapper => wrapper.unmount())
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

it('clears every toast group on Escape and ignores other keys', async () => {
  const wrapper = await mountSuspended(App, { route: '/contact', global: { stubs: {
    NuxtPage: true, MyAccountAuthDialog: true, Toast: true, ConfirmPopup: true, MyIcon: true,
  } } })
  wrappers.push(wrapper)
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
  expect(toast.removeAllGroups).not.toHaveBeenCalled()
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
  expect(toast.removeAllGroups).toHaveBeenCalledOnce()
})

it('renders ordinary toast text and a badge in structured toast details', async () => {
  const wrapper = await mountSuspended(App, { route: '/contact', global: { stubs: {
    NuxtPage: true,
    MyAccountAuthDialog: true,
    ConfirmPopup: true,
    MyIcon: true,
    Toast: { template: `
      <div>
        <slot name="message" :message="{ severity: 'warn', summary: '出错了', detail: '请重试' }" />
        <slot name="message" :message="{ severity: 'success', summary: '搞定', detail: { before: '封禁：', badge: '<小猪>', after: '等，共 2 名用户' } }" />
        <slot name="message" :message="{ severity: 'warn', summary: '出错了', detail: [
          { before: '', badge: '小明', after: '等 67 个用户：用户不存在' },
          { before: '', badge: '小红', after: '：不能封禁自己' },
        ] }" />
      </div>
    ` },
  } } })
  wrappers.push(wrapper)
  const [plain, rich, grouped] = wrapper.findAll('.p-toast-detail')
  expect(plain!.text()).toBe('请重试')
  expect(rich!.text()).toBe('封禁：<小猪>等，共 2 名用户')
  expect(rich!.get('.badge-info-outlined').text()).toBe('<小猪>')
  expect(grouped!.findAll('.badge-info-outlined').map(badge => badge.text())).toEqual(['小明', '小红'])
  expect(grouped!.element.children).toHaveLength(2)
  expect(Array.from(grouped!.element.children, row => row.textContent?.trim())).toEqual([
    '小明等 67 个用户：用户不存在',
    '小红：不能封禁自己',
  ])
})

it('hides the logo link at full collapse and restores it at the top', async () => {
  vi.stubGlobal('scrollY', 0)
  const wrapper = await mountSuspended(App, { route: '/contact', global: { stubs: {
    NuxtPage: true, MyAccountAuthDialog: true, Toast: true, ConfirmPopup: true, MyIcon: true,
  } } })
  wrappers.push(wrapper)
  const logo = wrapper.findAll('a').find(link => link.find('img[alt="Stupig Logo"]').exists())!
  for (const scroll_y of [0, 40, 80, 0]) {
    vi.stubGlobal('scrollY', scroll_y)
    window.dispatchEvent(new Event('scroll'))
    await nextTick()
    expect(logo.classes().includes('invisible')).toBe(scroll_y >= 80)
  }
})
