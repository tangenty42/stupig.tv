import type { Profile } from '@shared/types/user'
import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import dayjs from 'dayjs'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import ProfileSecurity from './ProfileSecurity.vue'

const start = dayjs('2026-11-23T00:00:00Z')
const now = ref(start)
const mocks = vi.hoisted(() => ({
  change_phone: vi.fn(),
  change_phone_for: vi.fn(),
  send_otp: vi.fn(),
  get_otp_cooldown: vi.fn(),
  listeners: new Map<string, Set<() => unknown>>(),
}))
vi.mock('~/composables/useApi', () => ({
  useApi: () => ({
    profile: { change_phone: mocks.change_phone, change_phone_for: mocks.change_phone_for },
    auth: { send_otp: mocks.send_otp, get_otp_cooldown: mocks.get_otp_cooldown },
  }),
}))
mockNuxtImport('useCaptcha', () => () => ({ verify: async () => ({ captcha_verify_param: 'verified' }) }))
mockNuxtImport('useMyToast', () => () => ({ ok: vi.fn(), error: vi.fn(), info: vi.fn() }))
mockNuxtImport('useDataSync', () => () => ({
  subscribe: (resource: string, listener: () => unknown) => {
    const listeners = mocks.listeners.get(resource) ?? new Set()
    listeners.add(listener)
    mocks.listeners.set(resource, listeners)
    return () => listeners.delete(listener)
  },
}))
mockNuxtImport('useReactiveDateNow', () => () => now)

const profile: Profile = {
  id: 7,
  username: 'user',
  phone: '13800000000',
  avatar_file: null,
  avatar_version: null,
  birthday: null,
  created_at: '2026-01-01T00:00:00.000Z',
  last_seen_at: null,
  is_online: true,
  is_verified: false,
  is_admin: false,
  is_banned: false,
  verified_note: null,
  editable: true,
  sensitive_readable: true,
  permissions: [],
}
const wrappers: { unmount: () => void }[] = []
beforeEach(() => {
  vi.clearAllMocks()
  now.value = start
  mocks.change_phone.mockResolvedValue(undefined)
  mocks.change_phone_for.mockResolvedValue(undefined)
  mocks.get_otp_cooldown.mockResolvedValue({ next_available_at: null, channels: { phone: null, identity: null } })
})
afterEach(() => {
  wrappers.splice(0).forEach(wrapper => wrapper.unmount())
  mocks.listeners.clear()
})

it.each([false, true])('validates against the live current phone and preserves its submission requirements (administrator: %s)', async (operating_other) => {
  const wrapper = await mountSuspended(ProfileSecurity, {
    props: { profile, isOperatingOther: operating_other },
    global: { stubs: { MyHeightSection: { template: '<section><slot /></section>' }, MyIcon: true } },
  })
  wrappers.push(wrapper)
  const form = wrapper.findAll('form')[1]!
  const phone = wrapper.get('#field-new_phone')
  if (! operating_other) {
    await wrapper.get('#field-old_otp').setValue('123456')
    await wrapper.get('#field-new_otp').setValue('654321')
  }
  else {
    expect(wrapper.find('#field-old_otp').exists()).toBe(false)
    expect(wrapper.find('#field-new_otp').exists()).toBe(false)
  }
  await phone.setValue(profile.phone)
  await form.trigger('submit')
  await flushPromises()
  expect(wrapper.get('#field-new_phone-error').text()).toBe('如改！')
  expect(mocks.change_phone).not.toHaveBeenCalled()
  expect(mocks.change_phone_for).not.toHaveBeenCalled()

  await wrapper.setProps({ profile: { ... profile, phone: '13900000000' } })
  await phone.setValue('13900000000')
  await form.trigger('submit')
  await flushPromises()
  expect(wrapper.get('#field-new_phone-error').text()).toBe('如改！')
  expect(mocks.change_phone).not.toHaveBeenCalled()
  expect(mocks.change_phone_for).not.toHaveBeenCalled()

  await phone.setValue('13800000000')
  if (! operating_other) {
    await wrapper.get('#field-old_otp').setValue('12')
    await wrapper.get('#field-new_otp').setValue('34')
    await form.trigger('submit')
    await flushPromises()
    expect(wrapper.get('#field-old_otp-error').text()).toBe('验证码为 6 位')
    expect(wrapper.get('#field-new_otp-error').text()).toBe('验证码为 6 位')
    expect(mocks.change_phone).not.toHaveBeenCalled()
    await wrapper.get('#field-old_otp').setValue('123456')
    await wrapper.get('#field-new_otp').setValue('654321')
  }
  await form.trigger('submit')
  await flushPromises()
  if (operating_other) {
    expect(mocks.change_phone_for).toHaveBeenCalledExactlyOnceWith(7, '13800000000')
    expect(mocks.change_phone).not.toHaveBeenCalled()
  }
  else {
    expect(mocks.change_phone).toHaveBeenCalledExactlyOnceWith({ new_phone: '13800000000', old_otp: '123456', new_otp: '654321', captcha_verify_param: 'verified' })
    expect(mocks.change_phone_for).not.toHaveBeenCalled()
  }
})

it.each([
  ['both', [true, true]],
  ['first only', [true, false]],
  ['neither', [false, false]],
] as const)('syncs all SMS buttons after each send (broker delivers %s)', async (_scenario, delivered) => {
  const identity_channel = 'otp-device:test'
  let deadline: string | null = null
  let sends = 0
  mocks.get_otp_cooldown.mockImplementation(async ({ phone }) => ({
    next_available_at: deadline,
    channels: { phone: `otp:${phone}`, identity: identity_channel },
  }))
  mocks.send_otp.mockImplementation(async () => {
    deadline = now.value.add(60, 'seconds').toISOString()
    if (delivered[sends ++]) {
      for (const resource of [`otp:${profile.phone}`, identity_channel]) {
        for (const notify of mocks.listeners.get(resource) ?? [])
          void notify()
      }
    }
  })

  const wrapper = await mountSuspended(ProfileSecurity, {
    props: { profile, isOperatingOther: false },
    global: { stubs: { MyHeightSection: { template: '<section><slot /></section>' }, MyIcon: true } },
  })
  wrappers.push(wrapper)
  const button = (field: string) => wrapper.get(`.p-inputgroup:has(#field-${field}) button`)
  const label = (text: string) => wrapper.findAll('button').find(el => el.text() === text)!
  const expect_cooldown = (fields: string[]) => {
    const old_phone_button = button('old_otp')
    expect(old_phone_button.text()).toMatch(/\d+ (?:秒|分钟)/)
    for (const field of fields) {
      expect(button(field).attributes('disabled')).toBeDefined()
      expect(button(field).text()).toBe(old_phone_button.text())
    }
  }

  await wrapper.get('#field-new_phone').setValue('13900000001')
  await flushPromises()
  await button('old_otp').trigger('click')
  await vi.waitFor(() => expect_cooldown(['old_otp', 'new_otp']))

  await label('打倒旧密码，我要新方案').trigger('click')
  await vi.waitFor(() => expect_cooldown(['old_otp', 'new_otp', 'otp']))

  now.value = start.add(61, 'seconds')
  await flushPromises()
  expect(button('otp').text()).toBe('发送')
  await button('otp').trigger('click')
  await vi.waitFor(() => expect_cooldown(['old_otp', 'new_otp', 'otp']))
  expect(mocks.send_otp.mock.calls.map(([input]) => input.purpose)).toEqual(['verify_old_phone', 'change_password'])
})
