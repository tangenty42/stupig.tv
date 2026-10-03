import type { H3Event } from 'h3'
import { ApiError } from '@server/errors/ApiError'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  config: {
    app: {
      auth: {
        jwt: {
          secret: 'unit-test-secret-with-at-least-32-characters',
          expiresInDays: 30,
          renewBeforeDays: 7,
        },
      },
    },
  },
  session: {
    get_auth_token_from_cookie: vi.fn(),
    verify_auth_token: vi.fn(),
    make_token_hash: vi.fn(),
    is_auth_token_expiring: vi.fn(),
    sign_auth_token: vi.fn(),
    set_auth_token_cookie: vi.fn(),
    set_auth_user_cookie: vi.fn(),
    get_client_ip: vi.fn(),
  },
  db: { execute: vi.fn(), getConnection: vi.fn() },
  sync: { publish_refresh: vi.fn() },
  sessions: { refresh_login_session: vi.fn() },
}))

vi.mock('@shared/config', () => ({ runtime_config: () => mocks.config }))
vi.mock('@server/lib/session', () => mocks.session)
vi.mock('@server/lib/db', () => ({ db: mocks.db }))
vi.mock('@server/services/session.service', () => mocks.sessions)
vi.mock('@server/lib/sync', async importOriginal => ({
  ... (await importOriginal<typeof import('@server/lib/sync')>()),
  publish_refresh: mocks.sync.publish_refresh,
}))

const get_request_header = vi.fn()
vi.stubGlobal('getRequestHeader', get_request_header)

const { require_admin_user, require_auth_user, resolve_operate_target } = await import('@server/services/auth-guards.service')

function create_event() {
  return {
    context: {},
    node: { req: { socket: { remoteAddress: '10.0.0.1' } } },
  } as unknown as H3Event
}

function create_record(overrides: Record<string, unknown> = {}) {
  return {
    id: 7,
    session_id: 11,
    generation_id: 21,
    is_newest_generation: 1,
    username: 'tester',
    phone: '13800138000',
    avatar_file: null,
    avatar_version: null,
    is_verified: 1,
    is_admin: 0,
    is_banned: 0,
    is_logged_out: 0,
    is_expired: 0,
    ... overrides,
  }
}

function use_record(record: Record<string, unknown> | null) {
  mocks.db.execute.mockResolvedValue([record ? [record] : [], []])
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.session.get_auth_token_from_cookie.mockReturnValue('presented-token')
  mocks.session.verify_auth_token.mockReturnValue({ sub: 7, jti: 'jti-1', iat: 1_700_000_000, exp: 1_800_000_000 })
  mocks.session.make_token_hash.mockResolvedValue('hash-of-token')
  mocks.session.is_auth_token_expiring.mockReturnValue(false)
  mocks.session.sign_auth_token.mockReturnValue({ token: 'rotated-token', exp: 1_900_000_000 })
  mocks.session.get_client_ip.mockReturnValue('203.0.113.1')
  mocks.sessions.refresh_login_session.mockResolvedValue(true)
  get_request_header.mockReturnValue(undefined)
  use_record(create_record())
})

describe('require_auth_user credential checks', () => {
  it('rejects a request without a token cookie', async () => {
    mocks.session.get_auth_token_from_cookie.mockReturnValue(null)

    await expect(require_auth_user(create_event())).rejects.toMatchObject({ statusCode: 401, message: '请先登录' })
    expect(mocks.db.execute).not.toHaveBeenCalled()
  })

  it('rejects a token that fails signature or expiry verification', async () => {
    mocks.session.verify_auth_token.mockImplementation(() => {
      throw new Error('jwt expired')
    })

    await expect(require_auth_user(create_event())).rejects.toMatchObject({ statusCode: 401, message: '登录状态已过期，请重新登录' })
    expect(mocks.db.execute).not.toHaveBeenCalled()
  })

  it('rejects a token whose generation is not in the session family', async () => {
    use_record(null)

    await expect(require_auth_user(create_event())).rejects.toMatchObject({ statusCode: 401, message: '登录状态无效，请重新登录' })
  })

  it('looks the generation up by the hash of the presented token', async () => {
    await require_auth_user(create_event())

    expect(mocks.session.make_token_hash).toHaveBeenCalledWith('presented-token')
    expect(mocks.db.execute).toHaveBeenCalledWith(expect.stringContaining('FROM user_login_session_tokens'), ['hash-of-token'])
  })

  it('rejects a banned account even with a valid token', async () => {
    use_record(create_record({ is_banned: 1 }))

    await expect(require_auth_user(create_event())).rejects.toMatchObject({ statusCode: 401, message: '账号已被禁用' })
  })

  it('rejects a generation of a session that was logged out', async () => {
    use_record(create_record({ is_logged_out: 1 }))

    await expect(require_auth_user(create_event())).rejects.toMatchObject({ statusCode: 401, message: '当前会话已退出或已失效' })
  })

  it('rejects a generation of a session whose idle window elapsed', async () => {
    use_record(create_record({ is_expired: 1 }))

    await expect(require_auth_user(create_event())).rejects.toMatchObject({ statusCode: 401, message: '登录会话已过期' })
    expect(mocks.sync.publish_refresh).toHaveBeenCalledWith({ resource: 'profile_sessions:7' })
  })

  it('reuses the resolved user within one batch instead of re-verifying', async () => {
    const event = create_event()
    const first = await require_auth_user(event)
    const second = await require_auth_user(event)

    expect(second).toBe(first)
    expect(mocks.db.execute).toHaveBeenCalledTimes(1)
    expect(event.context.auth_user).toBe(first)
  })

  it('returns the authenticated identity with boolean flags', async () => {
    use_record(create_record({ is_verified: 1, is_admin: 1 }))

    await expect(require_auth_user(create_event())).resolves.toEqual({
      id: 7,
      session_id: 11,
      username: 'tester',
      phone: '13800138000',
      avatar_file: null,
      is_verified: true,
      is_admin: true,
      permissions: [],
    })
  })
})

describe('require_auth_user token renewal', () => {
  it('only slides the session when the token still has enough life left', async () => {
    mocks.session.is_auth_token_expiring.mockReturnValue(false)

    await require_auth_user(create_event())

    expect(mocks.session.is_auth_token_expiring).toHaveBeenCalledWith(1_800_000_000, mocks.config.app.auth.jwt.renewBeforeDays)
    expect(mocks.sessions.refresh_login_session).toHaveBeenCalledWith({
      session_id: 11,
      presented_generation_id: 21,
      next: null,
      last_seen_ip: '203.0.113.1',
    })
    expect(mocks.session.set_auth_token_cookie).not.toHaveBeenCalled()
    expect(mocks.session.set_auth_user_cookie).not.toHaveBeenCalled()
  })

  it('hands out a new generation and refreshes the display cookie once due', async () => {
    mocks.session.is_auth_token_expiring.mockReturnValue(true)
    use_record(create_record({ is_verified: 1, is_admin: 1 }))

    await require_auth_user(create_event())

    expect(mocks.session.sign_auth_token).toHaveBeenCalledWith(7)
    expect(mocks.sessions.refresh_login_session).toHaveBeenCalledWith({
      session_id: 11,
      presented_generation_id: 21,
      next: { hash: 'hash-of-token', exp: 1_900_000_000 },
      last_seen_ip: '203.0.113.1',
    })
    expect(mocks.session.set_auth_token_cookie).toHaveBeenCalledWith(expect.anything(), 'rotated-token')
    expect(mocks.session.set_auth_user_cookie).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      id: 7,
      is_verified: true,
      is_admin: true,
    }))
  })

  it('withholds the rotated cookie when a concurrent renewal already appended', async () => {
    mocks.session.is_auth_token_expiring.mockReturnValue(true)
    mocks.sessions.refresh_login_session.mockResolvedValue(false)

    await require_auth_user(create_event())

    // The token it signed has no row, so handing it over would break the next
    // request.
    expect(mocks.session.set_auth_token_cookie).not.toHaveBeenCalled()
    expect(mocks.session.set_auth_user_cookie).not.toHaveBeenCalled()
  })

  it('never rotates an older generation, even when it is due', async () => {
    mocks.session.is_auth_token_expiring.mockReturnValue(true)
    use_record(create_record({ is_newest_generation: 0 }))

    await require_auth_user(create_event())

    expect(mocks.session.sign_auth_token).not.toHaveBeenCalled()
    expect(mocks.sessions.refresh_login_session).toHaveBeenCalledWith(expect.objectContaining({ next: null }))
  })

  it('does not renew on a Nuxt SSR prefetch, whose headers never reach the browser', async () => {
    mocks.session.is_auth_token_expiring.mockReturnValue(true)
    get_request_header.mockImplementation((_event: H3Event, name: string) => (name === 'x-nuxt-ssr' ? '1' : undefined))

    await require_auth_user(create_event())

    expect(mocks.sessions.refresh_login_session).not.toHaveBeenCalled()
    expect(mocks.session.set_auth_token_cookie).not.toHaveBeenCalled()
  })
})

describe('require_admin_user', () => {
  it('rejects an authenticated non-admin', async () => {
    await expect(require_admin_user(create_event())).rejects.toMatchObject({ statusCode: 403, message: '需要管理员权限' })
  })

  it('passes an admin through', async () => {
    use_record(create_record({ is_admin: 1 }))

    await expect(require_admin_user(create_event())).resolves.toMatchObject({ id: 7, is_admin: true })
  })
})

describe('resolve_operate_target', () => {
  it('defaults to the caller', async () => {
    await expect(resolve_operate_target(create_event())).resolves.toMatchObject({ target_id: 7 })
  })

  it('treats an explicit self target as the caller', async () => {
    await expect(resolve_operate_target(create_event(), 7)).resolves.toMatchObject({ target_id: 7 })
  })

  it('lets an admin operate on another user', async () => {
    use_record(create_record({ is_admin: 1 }))

    await expect(resolve_operate_target(create_event(), 99)).resolves.toMatchObject({ target_id: 99 })
  })

  it('refuses a non-admin targeting another user', async () => {
    await expect(resolve_operate_target(create_event(), 99)).rejects.toEqual(new ApiError(403, '权限不足'))
  })
})
