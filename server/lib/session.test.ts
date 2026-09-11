import type { H3Event } from 'h3'
import { ApiError } from '@server/errors/ApiError'
import jwt, { JsonWebTokenError, TokenExpiredError } from 'jsonwebtoken'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  env: {
    JWT_SECRET: 'unit-test-secret-with-at-least-32-characters',
    JWT_EXPIRES_IN_DAYS: 30,
    AUTH_TOKEN_COOKIE_NAME: 'auth_token',
    AUTH_USER_COOKIE_NAME: 'auth_user',
    COOKIE_MAX_AGE_DAYS: 45,
  },
}))

vi.mock('@shared/env', () => ({ env: mocks.env }))

const {
  clear_auth_token_cookie,
  get_auth_token_from_cookie,
  get_client_ip,
  is_auth_token_expiring,
  make_token_hash,
  set_auth_token_cookie,
  set_auth_user_cookie,
  sign_auth_token,
  verify_auth_token,
} = await import('@server/lib/session')

const set_cookie = vi.fn()
const delete_cookie = vi.fn()
const get_cookie = vi.fn()
const get_header = vi.fn()

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-09-11T08:00:00Z'))
  set_cookie.mockReset()
  delete_cookie.mockReset()
  get_cookie.mockReset()
  get_header.mockReset()
  vi.stubGlobal('setCookie', set_cookie)
  vi.stubGlobal('deleteCookie', delete_cookie)
  vi.stubGlobal('getCookie', get_cookie)
  vi.stubGlobal('getHeader', get_header)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

function create_event(remote_address = '10.0.0.1') {
  return {
    node: { req: { socket: { remoteAddress: remote_address } } },
  } as unknown as H3Event
}

function decode(token: string) {
  return jwt.decode(token) as jwt.JwtPayload
}

describe('sign_auth_token', () => {
  it('issues a verifiable token carrying the subject and a unique id', () => {
    const { token } = sign_auth_token(42)
    const payload = decode(token)

    expect(jwt.verify(token, mocks.env.JWT_SECRET)).toMatchObject(payload)
    expect(payload.sub).toBe(42)
    expect(typeof payload.jti).toBe('string')
    expect(payload.jti).not.toHaveLength(0)
  })

  it('gives every issuance a distinct jti so generations are distinguishable', () => {
    const first = sign_auth_token(42)
    const second = sign_auth_token(42)

    expect(first.token).not.toBe(second.token)
    expect(decode(first.token).jti).not.toBe(decode(second.token).jti)
  })

  it('returns the exp read back off the signed token', () => {
    const now = Math.floor(Date.now() / 1000)
    const { token, exp } = sign_auth_token(42)

    expect(exp).toBe(decode(token).exp)
    expect(exp).toBe(now + mocks.env.JWT_EXPIRES_IN_DAYS * 86400)
  })

  it('sets iat alongside exp so the renewal window is computable', () => {
    const payload = decode(sign_auth_token(42).token)

    expect(payload.iat).toBe(Math.floor(Date.now() / 1000))
  })
})

describe('verify_auth_token', () => {
  it('accepts a freshly issued token', () => {
    const { token, exp } = sign_auth_token(7)

    expect(verify_auth_token(token)).toMatchObject({ sub: 7, exp })
  })

  it('rejects an expired token', () => {
    const expired = jwt.sign({ sub: 7, jti: 'old' }, mocks.env.JWT_SECRET, { expiresIn: - 60 })

    expect(() => verify_auth_token(expired)).toThrow(TokenExpiredError)
  })

  it('rejects a token signed with a different secret', () => {
    const forged = jwt.sign({ sub: 7, jti: 'forged' }, 'a-different-secret-of-sufficient-length')

    expect(() => verify_auth_token(forged)).toThrow(JsonWebTokenError)
  })

  it('rejects a malformed token', () => {
    expect(() => verify_auth_token('not-a-jwt')).toThrow()
  })

  it.each([
    ['a missing jti', { sub: 7 }],
    ['a missing sub', { jti: 'x' }],
    ['a non-numeric sub', { sub: '7', jti: 'x' }],
    ['a non-string jti', { sub: 7, jti: 12 }],
  ])('rejects a token with %s even when the signature is valid', (_label, payload) => {
    const token = jwt.sign(payload, mocks.env.JWT_SECRET, { expiresIn: 600 })

    expect(() => verify_auth_token(token)).toThrow(ApiError)

    try {
      verify_auth_token(token)
    }
    catch (error) {
      expect((error as ApiError).statusCode).toBe(401)
      expect((error as ApiError).message).toBe('登录状态已过期，请重新登录')
    }
  })
})

describe('is_auth_token_expiring', () => {
  const now = () => Math.floor(Date.now() / 1000)

  it('is true once the remaining lifetime reaches the window', () => {
    expect(is_auth_token_expiring(now() + 7 * 86400, 7)).toBe(true)
  })

  it('is false while the token still outlives the window', () => {
    expect(is_auth_token_expiring(now() + 7 * 86400 + 1, 7)).toBe(false)
  })

  it('is true for an already expired token', () => {
    expect(is_auth_token_expiring(now() - 1, 7)).toBe(true)
  })

  it('is false for a freshly issued token when the window is zero', () => {
    expect(is_auth_token_expiring(now() + mocks.env.JWT_EXPIRES_IN_DAYS * 86400, 0)).toBe(false)
  })
})

describe('make_token_hash', () => {
  it('hashes deterministically to hex so the same token matches its stored row', async () => {
    const first = await make_token_hash('a-token')
    const second = await make_token_hash('a-token')

    expect(first).toBe(second)
    expect(first).toMatch(/^[0-9a-f]{64}$/)
  })

  it('separates different tokens', async () => {
    expect(await make_token_hash('a-token')).not.toBe(await make_token_hash('b-token'))
  })
})

describe('auth token cookie', () => {
  it('reads the token cookie by the configured name', () => {
    get_cookie.mockReturnValue('cookie-token')

    expect(get_auth_token_from_cookie(create_event())).toBe('cookie-token')
    expect(get_cookie).toHaveBeenCalledWith(expect.anything(), 'auth_token')
  })

  it('returns null when the cookie is absent', () => {
    get_cookie.mockReturnValue(undefined)

    expect(get_auth_token_from_cookie(create_event())).toBeNull()
  })

  it('writes an httpOnly, secure, lax cookie with the configured max age', () => {
    set_auth_token_cookie(create_event(), 'signed-token')

    expect(set_cookie).toHaveBeenCalledWith(expect.anything(), 'auth_token', 'signed-token', {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/',
      maxAge: mocks.env.COOKIE_MAX_AGE_DAYS * 86400,
    })
  })

  it('clears the cookie with the same attributes it was written with', () => {
    clear_auth_token_cookie(create_event())

    expect(delete_cookie).toHaveBeenCalledWith(expect.anything(), 'auth_token', {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/',
    })
  })
})

describe('set_auth_user_cookie', () => {
  it('serializes the user with a lifetime matching the token cookie', () => {
    set_auth_user_cookie(create_event(), {
      id: 7,
      username: 'tester',
      phone: '13800138000',
      avatar_file: null,
      avatar_version: null,
      is_verified: true,
      is_admin: false,
    })

    const [, name, value, options] = set_cookie.mock.calls[0] as [unknown, string, string, Record<string, unknown>]

    expect(name).toBe('auth_user')
    expect(JSON.parse(value)).toMatchObject({ id: 7, username: 'tester', is_admin: false })
    expect(options).toMatchObject({ sameSite: 'lax', path: '/', maxAge: mocks.env.COOKIE_MAX_AGE_DAYS * 86400 })
    expect(options).not.toHaveProperty('httpOnly')
  })
})

describe('get_client_ip', () => {
  it('takes the first hop of x-forwarded-for', () => {
    get_header.mockReturnValue('203.0.113.9, 10.1.1.1 , 10.2.2.2')

    expect(get_client_ip(create_event())).toBe('203.0.113.9')
  })

  it('falls back to the socket address when the header is missing', () => {
    get_header.mockReturnValue(undefined)

    expect(get_client_ip(create_event('192.168.1.5'))).toBe('192.168.1.5')
  })
})
