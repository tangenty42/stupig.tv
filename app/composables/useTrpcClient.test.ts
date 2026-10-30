import { workspace_issue } from '@shared/content-workspace'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope, ref, watch } from 'vue'

const mocks = vi.hoisted(() => ({ logout: vi.fn(), response: {} as unknown, fetch: undefined as typeof globalThis.fetch | undefined }))
vi.mock('@trpc/client', () => ({ createTRPCClient: () => ({}), splitLink: () => ({}),
  httpLink: (options: { fetch: typeof globalThis.fetch }) => {
    mocks.fetch = options.fetch
    return {}
  }, httpBatchLink: () => ({}) }))

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
  it('starts a small pagehide release as keepalive, while ordinary mutations remain normal requests', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response('{}'))
    vi.stubGlobal('fetch', fetch)
    useTrpcClient()
    await mocks.fetch!('/api/trpc/content.commandDraft', { method: 'POST', body: JSON.stringify({ kind: 'release' }) })
    expect(fetch).toHaveBeenLastCalledWith('/api/trpc/content.commandDraft', expect.objectContaining({ keepalive: true, credentials: 'include' }))
    await mocks.fetch!('/api/trpc/content.commandDraft', { method: 'POST', body: JSON.stringify({ kind: 'sync' }) })
    expect(fetch.mock.calls.at(- 1)?.[1]).not.toHaveProperty('keepalive')
  })
  const applicationError = { code: 'BATCH_REJECTED' as const, details: { items: [workspace_issue('a.txt', 'name_conflict', 'NAME_CONFLICT', '同名文件已存在')], valid_count: 0 } }
  it('keeps typed details through ordinary API error normalization', async () => {
    const error = Object.assign(new Error('整批未执行'), { data: { httpStatus: 400, applicationError } })
    await expect(useTrpcClient().call(Promise.reject(error))).rejects.toMatchObject({ status: 400, ... applicationError })
  })
  it.each(['REF_HISTORY_UNAVAILABLE'] as const)('preserves %s through API error normalization', async (code) => {
    const error = Object.assign(new Error('引用需要处理'), { data: { httpStatus: 409, applicationError: { code } } })
    await expect(useTrpcClient().call(Promise.reject(error))).rejects.toMatchObject({ status: 409, code })
  })
  it('preserves the reference review token through API error normalization', async () => {
    const details = { review_token: 'a'.repeat(64) }
    const error = Object.assign(new Error('引用需要处理'), { data: { httpStatus: 409, applicationError: { code: 'REF_HISTORY_UNAVAILABLE', details } } })
    await expect(useTrpcClient().call(Promise.reject(error))).rejects.toMatchObject({ status: 409, code: 'REF_HISTORY_UNAVAILABLE', details })
  })
  it('keeps the same typed details through the XHR path and its second normalization', async () => {
    mocks.response = { error: { message: '整批未执行', data: { httpStatus: 400, applicationError } } }
    await expect(useTrpcClient().upload('profile.uploadAvatar', new FormData())).rejects.toMatchObject({ status: 400, ... applicationError })
  })
  it('rejects unknown or unsafe error detail shapes', () => {
    const error = new TrpcApiError('expected', 400, Object.assign({}, applicationError, { details: { ... applicationError.details, sql: 'private' } }))
    expect(error.code).toBeUndefined()
    expect(error.details).toBeUndefined()
  })
})
