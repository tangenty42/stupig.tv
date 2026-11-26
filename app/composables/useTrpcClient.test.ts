import { workspace_issue } from '@shared/content-workspace'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope, ref, watch } from 'vue'
import { error_message } from '~/utils/error'
import { TrpcApiError, useTrpcClient } from './useTrpcClient'

const mocks = { logout: vi.fn(), response: {} as unknown }

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

let active_app: object
let active_logout: ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.clearAllMocks()
  active_app = {}
  active_logout = mocks.logout
  vi.stubGlobal('useNuxtApp', () => active_app)
  vi.stubGlobal('useAuth', () => ({ logout: active_logout, user: ref(null) }))
  vi.stubGlobal('effectScope', effectScope)
  vi.stubGlobal('watch', watch)
  vi.stubGlobal('useReactiveDateNow', () => ref(0))
  vi.stubGlobal('XMLHttpRequest', FakeXHR)
})
afterEach(() => vi.unstubAllGlobals())

describe('tRPC application error transport', () => {
  const unauthorized = () => Promise.reject(Object.assign(new Error('expired'), { status: 401 }))

  it('isolates concurrent 401 handling between Nuxt application instances', async () => {
    let finish_first!: () => void
    const first_logout = vi.fn(() => new Promise<void>(resolve => finish_first = resolve))
    const second_logout = vi.fn(async () => {})

    active_app = {}
    active_logout = first_logout
    const first_client = useTrpcClient()
    active_app = {}
    active_logout = second_logout
    const second_client = useTrpcClient()

    const first = first_client.call(unauthorized()).catch(error => error)
    await Promise.resolve()
    const second = second_client.call(unauthorized()).catch(error => error)
    await Promise.resolve()
    await Promise.resolve()

    expect(first_logout).toHaveBeenCalledOnce()
    expect(second_logout).toHaveBeenCalledOnce()
    finish_first()
    await Promise.all([first, second])
  })

  it('coalesces concurrent 401 handling within one Nuxt application instance', async () => {
    let finish_logout!: () => void
    mocks.logout.mockImplementationOnce(() => new Promise<void>(resolve => finish_logout = resolve))
    const first_client = useTrpcClient()
    const second_client = useTrpcClient()
    const first = first_client.call(unauthorized()).catch(error => error)
    const second = second_client.call(unauthorized()).catch(error => error)
    await Promise.resolve()
    await Promise.resolve()
    expect(mocks.logout).toHaveBeenCalledOnce()
    finish_logout()
    await Promise.all([first, second])
  })

  it('handles another 401 after the previous application-scoped task completes', async () => {
    const client = useTrpcClient()
    await expect(client.call(unauthorized())).rejects.toMatchObject({ status: 401 })
    await expect(client.call(unauthorized())).rejects.toMatchObject({ status: 401 })
    expect(mocks.logout).toHaveBeenCalledTimes(2)
  })

  it('starts a small pagehide release as keepalive, while ordinary mutations remain normal requests', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ result: { data: null } }))
    vi.stubGlobal('fetch', fetch)
    const { client, call } = useTrpcClient()
    const command = {
      id: 'a'.repeat(32),
      lease: { page_id: 'b'.repeat(32), token: 'c'.repeat(32), epoch: 1 },
      seq: 1,
      base_namespace_revision: 1,
      base_title_revision: 1,
    }
    await call(client.content.commandDraft.mutate({ ... command, kind: 'release' }))
    expect(fetch).toHaveBeenLastCalledWith('/api/trpc/content.commandDraft', expect.objectContaining({ keepalive: true, credentials: 'include' }))
    await call(client.content.commandDraft.mutate({ ... command, kind: 'sync' }))
    expect(fetch.mock.calls.at(- 1)?.[1]).not.toHaveProperty('keepalive')
  })

  it('shows the existing network fallback when a browser read fails before receiving a response', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>().mockRejectedValueOnce(new TypeError('Failed to fetch')))
    const { client, call } = useTrpcClient()
    const error = await call(client.content.listStories.query()).catch(error => error)
    expect(error).toBeInstanceOf(TrpcApiError)
    expect(error.status).toBeUndefined()
    expect(error_message(error)).toBe('《我们仍未知道那天所发生の网络错误の名字》')
  })

  it('keeps an intentionally aborted read out of the error toast', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>().mockRejectedValueOnce(new DOMException('The operation was aborted.', 'AbortError')))
    const { client, call } = useTrpcClient()
    const error = await call(client.content.listStories.query()).catch(error => error)
    expect(error_message(error)).toBe('')
  })

  it('preserves the server message and HTTP status for a rejected read', async () => {
    const message = '档案发生变化，请刷新'
    vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(Response.json([{
      error: { message, code: - 32009, data: { code: 'CONFLICT', httpStatus: 409 } },
    }], { status: 409 })))
    const { client, call } = useTrpcClient()
    const error = await call(client.content.listStories.query()).catch(error => error)
    expect(error).toMatchObject({ message, status: 409 })
    expect(error_message(error)).toBe(message)
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
