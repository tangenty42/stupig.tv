import type { LoginUser } from './useAuth'
import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from 'vitest'
import { defineComponent, ref } from 'vue'
import { useAuth } from './useAuth'

const mocks = vi.hoisted(() => ({
  broadcast_logout: vi.fn(),
  info: vi.fn(),
  dead: vi.fn(),
  reload: vi.fn(),
}))
const user = ref<LoginUser | null>(null)
mockNuxtImport('useCookie', () => () => user)
mockNuxtImport('useDataSync', () => () => ({ broadcast_logout: mocks.broadcast_logout }))
mockNuxtImport('useMyToast', () => () => ({ info: mocks.info, dead: mocks.dead }))
mockNuxtImport('reloadNuxtApp', () => mocks.reload)

const LogoutActions = defineComponent({
  setup: useAuth,
  template: '<div><button @click="logout">退出</button><button @click="handle_remote_logout">收到退出通知</button></div>',
})

beforeEach(() => {
  user.value = { id: 1, username: '测试账号', phone: '10000000000', avatar_file: null, avatar_version: null, is_verified: false }
  vi.stubGlobal('$fetch', vi.fn().mockResolvedValue(undefined))
})

afterEach(() => {
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

it('keeps the farewell order and forces an identity reload even after a recent reload', async () => {
  const wrapper = await mountSuspended(LogoutActions)
  onTestFinished(() => wrapper.unmount())

  await wrapper.get('button').trigger('click')
  await flushPromises()
  expect(user.value).toBeNull()
  expect(mocks.broadcast_logout).toHaveBeenCalledOnce()
  expect(mocks.info).toHaveBeenCalledWith('再见！Ciao~')
  expect(mocks.info.mock.invocationCallOrder[0]).toBeLessThan(mocks.dead.mock.invocationCallOrder[0]!)
  expect(mocks.dead.mock.invocationCallOrder[0]).toBeLessThan(mocks.reload.mock.invocationCallOrder[0]!)
  expect(mocks.reload).toHaveBeenCalledExactlyOnceWith({ force: true })
})

it('forces the remote logout reload and ignores a repeated notification', async () => {
  const wrapper = await mountSuspended(LogoutActions)
  onTestFinished(() => wrapper.unmount())
  const remote = wrapper.findAll('button')[1]!
  await remote.trigger('click')
  await remote.trigger('click')
  expect(user.value).toBeNull()
  expect(mocks.info).not.toHaveBeenCalled()
  expect(mocks.reload).toHaveBeenCalledExactlyOnceWith({ force: true })
})
