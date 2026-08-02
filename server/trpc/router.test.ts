import type { AuthUser } from '@server/types/auth'
import type { H3Event } from 'h3'
import { ApiError } from '@server/errors/ApiError'
import { public_procedure, router } from '@server/trpc/init'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const auth_mocks = vi.hoisted(() => ({
  require_auth_user: vi.fn(),
  require_admin_user: vi.fn(),
  resolve_operate_target: vi.fn(),
}))

vi.mock('@server/services/auth-guards.service', () => auth_mocks)

const { app_router } = await import('@server/trpc/router')

const auth_user: AuthUser = {
  id: 7,
  username: 'tester',
  phone: '13800138000',
  avatar_file: null,
  is_verified: true,
  is_admin: true,
  token_hash: 'token-hash',
}

function create_event() {
  return {
    context: { identity_token: 'test-device' },
  } as unknown as H3Event
}

describe('tRPC router contracts', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    auth_mocks.require_auth_user.mockResolvedValue(auth_user)
    auth_mocks.require_admin_user.mockResolvedValue(auth_user)
  })

  it('serves public procedures without authentication', async () => {
    const caller = app_router.createCaller({ event: create_event() })

    await expect(caller.system.health()).resolves.toEqual({ online: true })
    expect(auth_mocks.require_auth_user).not.toHaveBeenCalled()
  })

  it('passes the original H3 event through protected procedure context', async () => {
    const event = create_event()
    const caller = app_router.createCaller({ event })

    await expect(caller.system.me()).resolves.toEqual({
      id: auth_user.id,
      username: auth_user.username,
      is_admin: true,
    })
    expect(auth_mocks.require_auth_user).toHaveBeenCalledWith(event)
  })

  it('maps existing API authorization errors to tRPC status codes', async () => {
    auth_mocks.require_auth_user.mockRejectedValue(new ApiError(401, '请先登录'))
    const caller = app_router.createCaller({ event: create_event() })

    await expect(caller.system.me()).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      message: '请先登录',
    })
  })

  it('rejects invalid Zod inputs before invoking a service', async () => {
    const caller = app_router.createCaller({ event: create_event() })

    await expect(caller.content.getStory({ id: 0 })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    })
  })

  it('accepts FormData transport and preserves upload validation errors', async () => {
    const caller = app_router.createCaller({ event: create_event() })
    const form = new FormData()
    form.append('story_id', '1')

    await expect(caller.content.uploadAttachment(form)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: '请先选择要上传的文件',
    })
  })

  it.each([
    [400, 'BAD_REQUEST'],
    [401, 'UNAUTHORIZED'],
    [403, 'FORBIDDEN'],
    [404, 'NOT_FOUND'],
    [409, 'CONFLICT'],
    [413, 'PAYLOAD_TOO_LARGE'],
    [415, 'UNSUPPORTED_MEDIA_TYPE'],
    [429, 'TOO_MANY_REQUESTS'],
    [502, 'BAD_GATEWAY'],
  ] as const)('maps ApiError status %i to %s', async (status, code) => {
    const error_router = router({
      fail: public_procedure.query(() => {
        throw new ApiError(status, 'expected error')
      }),
    })

    await expect(error_router.createCaller({ event: create_event() }).fail()).rejects.toMatchObject({
      code,
      message: 'expected error',
    })
  })
})
