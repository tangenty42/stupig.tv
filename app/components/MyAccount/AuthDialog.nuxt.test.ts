import type { AuthResult } from '@shared/types/auth'
import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { DOMWrapper, flushPromises } from '@vue/test-utils'
import SelectButton from 'primevue/selectbutton'
import { beforeEach, expect, it, onTestFinished, vi } from 'vitest'
import { ref } from 'vue'
import AuthDialog from './AuthDialog.vue'

const mocks = vi.hoisted(() => ({
  login_with_phone: vi.fn(),
  set_initial_password: vi.fn(),
  apply_auth: vi.fn(),
}))
vi.mock('~/composables/useApi', () => ({
  useApi: () => ({
    auth: {
      login_with_phone: mocks.login_with_phone,
      get_otp_cooldown: async () => ({ next_available_at: null, channels: { phone: null, identity: null } }),
    },
    profile: { set_initial_password: mocks.set_initial_password },
  }),
}))
mockNuxtImport('useAuth', () => () => ({ apply_auth: mocks.apply_auth }))
mockNuxtImport('useCaptcha', () => () => ({ verify: async () => ({ captcha_verify_param: 'verified' }), showing: ref(false) }))
mockNuxtImport('useMyToast', () => () => ({ ok: vi.fn(), error: vi.fn(), info: vi.fn() }))
mockNuxtImport('useDataSync', () => () => ({ subscribe: () => () => {} }))

const user: AuthResult['user'] = {
  id: 7,
  username: 'user',
  phone: '13800000000',
  avatar_file: null,
  avatar_version: null,
  is_verified: false,
  is_admin: false,
  permissions: [],
}

beforeEach(() => vi.clearAllMocks())

it.each([true, false])('only offers to set a password after a flagged phone login (flagged: %s)', async (needs_password_setup) => {
  const receipt = needs_password_setup ? { user, needs_password_setup: true } : { user }
  mocks.login_with_phone.mockResolvedValue(receipt)
  mocks.set_initial_password.mockResolvedValue(undefined)
  const wrapper = await mountSuspended(AuthDialog, {
    attachTo: document.body,
    props: { 'visible': true, 'onUpdate:visible': vi.fn() },
    global: { stubs: { transition: false, MyIcon: true } },
  })
  onTestFinished(() => wrapper.unmount())
  const body = new DOMWrapper(document.body)

  wrapper.getComponent(SelectButton).vm.$emit('update:modelValue', 'phone')
  await vi.waitFor(() => expect(body.find('#login-phone-form #field-otp').exists()).toBe(true), { timeout: 5000 })
  const login_form = body.get('#login-phone-form')
  await login_form.get('#field-phone').setValue(user.phone)
  await login_form.get('#field-otp').setValue('123456')
  await login_form.trigger('submit')
  await flushPromises()
  expect(mocks.apply_auth).toHaveBeenCalledExactlyOnceWith(receipt)
  expect(wrapper.emitted('update:visible')).toEqual([[false]])
  expect(body.find('#password-setup-form').exists()).toBe(false)

  await wrapper.setProps({ visible: false })
  await vi.waitFor(() => expect(body.find('#login-phone-form').exists()).toBe(false))
  if (! needs_password_setup) {
    expect(body.find('#password-setup-form').exists()).toBe(false)
    return
  }

  await vi.waitFor(() => expect(body.find('#password-setup-confirm').exists()).toBe(true), { timeout: 5000 })
  const setup_form = body.get('#password-setup-form')
  await setup_form.get('#password-setup-new').setValue('Example!953')
  await setup_form.get('#password-setup-confirm').setValue('Example!953')
  await setup_form.trigger('submit')
  await flushPromises()
  expect(mocks.set_initial_password).toHaveBeenCalledExactlyOnceWith({ new_password: 'Example!953', confirm_new_password: 'Example!953' })
  await vi.waitFor(() => expect(body.find('#password-setup-form').exists()).toBe(false))
})
