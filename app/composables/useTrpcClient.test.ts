import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope, ref, watch } from 'vue'

const mocks = vi.hoisted(() => ({ logout: vi.fn(), response: {} as unknown }))
vi.mock('@trpc/client', () => ({ createTRPCClient: () => ({}), httpBatchLink: () => ({}) }))

class FakeXHR {
  status = 400
  responseText = ''
  upload = { addEventListener: vi.fn() }
  withCredentials = false
  listeners = new Map<string, () => void>()
  open() {}
  setRequestHeader() {}
  addEventListener(name: string, listener: () => void) { this.listeners.set(name, listener) }
  send() {
    this.responseText = JSON.stringify(mocks.response)
    this.listeners.get('load')?.()
  }

  abort() { this.listeners.get('abort')?.() }
}

const { TrpcApiError, useTrpcClient } = await import('./useTrpcClient')

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('useAuth', () => ({ logout: mocks.logout, user: ref(null) }))
  vi.stubGlobal('effectScope', effectScope)
  vi.stubGlobal('watch', watch)
  vi.stubGlobal('useReactiveDateNow', () => ref(0))
  vi.stubGlobal('XMLHttpRequest', FakeXHR)
})
afterEach(() => vi.unstubAllGlobals())

describe('tRPC application error transport', () => {
  const applicationError = { code: 'LEGACY_REF' as const, details: { lines: [5, 7] } }
  it('keeps typed details through ordinary API error normalization', async () => {
    const error = Object.assign(new Error('旧引用'), { data: { httpStatus: 400, applicationError } })
    await expect(useTrpcClient().call(Promise.reject(error))).rejects.toMatchObject({ status: 400, ... applicationError })
  })
  it('keeps the same typed details through the XHR path and its second normalization', async () => {
    mocks.response = { error: { message: '旧引用', data: { httpStatus: 400, applicationError } } }
    await expect(useTrpcClient().upload('profile.uploadAvatar', new FormData())).rejects.toMatchObject({ status: 400, ... applicationError })
  })
  it('rejects unknown or unsafe error detail shapes', () => {
    const error = new TrpcApiError('expected', 400, Object.assign({}, applicationError, { details: { lines: [5], sql: 'private' } }))
    expect(error.code).toBeUndefined()
    expect(error.details).toBeUndefined()
  })
})
