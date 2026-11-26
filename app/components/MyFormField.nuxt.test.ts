import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { afterEach, expect, it, vi } from 'vitest'
import MyFormField from './MyFormField.vue'

interface Cooldown { next_available_at: string | null, channels: { phone: string, identity: string } }

const { requests, listeners } = vi.hoisted(() => ({
  requests: [] as Array<{ phone: string, resolve: (value: Cooldown) => void }>,
  listeners: new Map<string, () => unknown>(),
}))

function cooldown(phone: string): Cooldown {
  return { next_available_at: null, channels: { phone: `otp:${phone}`, identity: `otp-identity:${phone}` } }
}

vi.mock('~/composables/useApi', () => ({
  useApi: () => ({
    auth: {
      get_otp_cooldown: ({ phone }: { phone: string }) => {
        // The first request per mount answers at once so setup can finish.
        if (! requests.length) {
          requests.push({ phone, resolve: () => {} })
          return Promise.resolve(cooldown(phone))
        }
        return new Promise<Cooldown>(resolve => requests.push({ phone, resolve }))
      },
    },
  }),
}))
mockNuxtImport('useDataSync', () => () => ({
  subscribe: (resource: string, listener: () => unknown) => {
    listeners.set(resource, listener)
    return () => listeners.delete(resource)
  },
}))

const wrappers: { unmount: () => void }[] = []
afterEach(() => {
  wrappers.splice(0).forEach(wrapper => wrapper.unmount())
  requests.length = 0
  listeners.clear()
})

it('keeps the current phone channels when an earlier phone response arrives late', async () => {
  const otp = (phone: string) => ({ sendHandler: async () => {}, targetPhone: phone, purpose: 'login' as const })
  const wrapper = await mountSuspended(MyFormField, { props: { name: 'otp', as: 'InputOtp', otpSend: otp('13800000001') } })
  wrappers.push(wrapper)
  await flushPromises()
  expect([... listeners.keys()].sort()).toEqual(['otp-identity:13800000001', 'otp:13800000001'])

  void listeners.get('otp:13800000001')!()
  await wrapper.setProps({ otpSend: otp('13800000002') })
  await flushPromises()
  const late = requests.find((request, index) => index > 0 && request.phone === '13800000001')!
  requests.find(request => request.phone === '13800000002')!.resolve(cooldown('13800000002'))
  await flushPromises()
  late.resolve(cooldown('13800000001'))
  await flushPromises()

  expect([... listeners.keys()].sort()).toEqual(['otp-identity:13800000002', 'otp:13800000002'])
})
