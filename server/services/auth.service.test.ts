import type { H3Event } from 'h3'
import bcrypt from 'bcryptjs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  config: {
    app: {
      auth: {
        jwt: { secret: 'unit-test-secret-with-at-least-32-characters', expiresInDays: 30 },
        bcryptRounds: 4,
      },
      otp: {
        tier1: { dailyLimit: 5, cooldownMs: 60_000 },
        tier2: { dailyLimit: 5, cooldownMs: 300_000 },
      },
    },
  },
  db: { execute: vi.fn(), getConnection: vi.fn() },
  captcha: { verify_captcha: vi.fn() },
  sms: { send_otp_sms: vi.fn(), check_otp_sms: vi.fn() },
  session_lib: {
    sign_auth_token: vi.fn(),
    make_token_hash: vi.fn(),
    set_auth_token_cookie: vi.fn(),
    clear_auth_token_cookie: vi.fn(),
  },
  sessions: { create_login_session: vi.fn(), logout_session: vi.fn() },
  guards: { require_auth_user: vi.fn() },
  sync: { publish_refresh: vi.fn() },
}))

vi.mock('@shared/config', () => ({ runtime_config: () => mocks.config }))
vi.mock('@server/lib/db', () => ({ db: mocks.db }))
vi.mock('@server/lib/captcha', () => mocks.captcha)
vi.mock('@server/lib/sms', () => mocks.sms)
vi.mock('@server/lib/session', () => mocks.session_lib)
vi.mock('@server/services/session.service', () => mocks.sessions)
vi.mock('@server/services/auth-guards.service', () => mocks.guards)
vi.mock('@server/lib/sync', async importOriginal => ({
  ... (await importOriginal<typeof import('@server/lib/sync')>()),
  publish_refresh: mocks.sync.publish_refresh,
}))

const {
  get_otp_cooldown,
  login_with_password,
  login_with_phone,
  logout_user,
  register_user,
  send_otp,
  send_otp_for_request,
} = await import('@server/services/auth.service')

const DEVICE = 'device-a'
const PHONE = '13800138000'

function create_event() {
  return { context: {} } as unknown as H3Event
}

function create_device_context() {
  return { login_ip: '203.0.113.1', last_seen_ip: '203.0.113.1', user_agent: 'vitest' }
}

/** Sequel between "how many codes has this sender already used today" and the log row. */
function use_otp_log(sent_count: number) {
  mocks.db.execute.mockImplementation(async (sql: string) => {
    if (sql.includes('COUNT(*)')) {
      return [[{ send_count: sent_count }], []]
    }
    return [{ affectedRows: 1 }, []]
  })
}

const start_of_day = new Date('2026-09-11T00:00:00Z')

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-09-11T08:00:00Z'))
  vi.clearAllMocks()
  mocks.captcha.verify_captcha.mockResolvedValue(undefined)
  mocks.sms.send_otp_sms.mockResolvedValue(undefined)
  mocks.sms.check_otp_sms.mockResolvedValue(undefined)
  mocks.session_lib.sign_auth_token.mockReturnValue({ token: 'issued-token', exp: 1_900_000_000 })
  mocks.session_lib.make_token_hash.mockResolvedValue('token-hash')
  mocks.sessions.create_login_session.mockResolvedValue(undefined)
  mocks.guards.require_auth_user.mockResolvedValue({
    id: 7,
    session_id: 11,
    username: 'tester',
    phone: PHONE,
    avatar_file: null,
    is_verified: true,
    is_admin: false,
  })
  use_otp_log(0)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('send_otp rate limiting', () => {
  function insert_call() {
    return mocks.db.execute.mock.calls.find(call => String(call[0]).includes('INSERT INTO otp_send_logs'))
  }

  it('sends the first code of the day and opens the short cooldown', async () => {
    await send_otp({ phone: PHONE, purpose: 'login' }, { identity_token: DEVICE })

    expect(mocks.sms.send_otp_sms).toHaveBeenCalledWith({
      phone: PHONE,
      out_id: expect.stringMatching(/^device-a-\d+$/),
    })
    expect(insert_call()?.[1]).toEqual([
      DEVICE,
      PHONE,
      'login',
      new Date(Date.now() + mocks.config.app.otp.tier1.cooldownMs),
    ])
  })

  it('keeps the short cooldown for the rest of the first tier', async () => {
    use_otp_log(4)

    await send_otp({ phone: PHONE, purpose: 'login' }, { identity_token: DEVICE })

    expect(insert_call()?.[1]?.[3]).toEqual(new Date(Date.now() + mocks.config.app.otp.tier1.cooldownMs))
  })

  it('uses the long cooldown once the sender has already sent from the second tier', async () => {
    use_otp_log(6)

    await send_otp({ phone: PHONE, purpose: 'login' }, { identity_token: DEVICE })

    expect(insert_call()?.[1]?.[3]).toEqual(new Date(Date.now() + mocks.config.app.otp.tier2.cooldownMs))
  })

  it('still uses the short cooldown for the send that crosses into the second tier', async () => {
    // The cooldown is picked from the tier the previous send belonged to, so the
    // 5th send -- the first one counted into tier 2 -- opens tier 1's short window.
    use_otp_log(mocks.config.app.otp.tier1.dailyLimit)

    await send_otp({ phone: PHONE, purpose: 'login' }, { identity_token: DEVICE })

    expect(mocks.sms.send_otp_sms).toHaveBeenCalledTimes(1)
    expect(insert_call()?.[1]?.[3]).toEqual(new Date(Date.now() + mocks.config.app.otp.tier1.cooldownMs))
  })

  it('closes the window for the rest of the UTC day on the last allowed send', async () => {
    use_otp_log(mocks.config.app.otp.tier1.dailyLimit + mocks.config.app.otp.tier2.dailyLimit - 1)

    await send_otp({ phone: PHONE, purpose: 'login' }, { identity_token: DEVICE })

    expect(mocks.sms.send_otp_sms).toHaveBeenCalledTimes(1)
    expect(insert_call()?.[1]?.[3]).toEqual(new Date('2026-09-12T00:00:00.000Z'))
  })

  it('refuses to send once the daily cap is reached, without calling the provider', async () => {
    use_otp_log(mocks.config.app.otp.tier1.dailyLimit + mocks.config.app.otp.tier2.dailyLimit)

    await expect(send_otp({ phone: PHONE, purpose: 'login' }, { identity_token: DEVICE }))
      .rejects.toMatchObject({ statusCode: 429, message: '已达到发送上限' })

    expect(mocks.sms.send_otp_sms).not.toHaveBeenCalled()
    expect(insert_call()).toBeUndefined()
  })

  it('counts both the device and the phone number against the cap', async () => {
    use_otp_log(0)

    await send_otp({ phone: PHONE, purpose: 'register' }, { identity_token: DEVICE })

    const count_call = mocks.db.execute.mock.calls.find(call => String(call[0]).includes('COUNT(*)'))
    expect(String(count_call?.[0])).toContain('(identity_token = ? OR phone = ?)')
    expect(count_call?.[1]).toEqual([DEVICE, PHONE, start_of_day])
  })

  it('does not log a send when the provider fails', async () => {
    mocks.sms.send_otp_sms.mockRejectedValue(new Error('provider down'))

    await expect(send_otp({ phone: PHONE, purpose: 'login' }, { identity_token: DEVICE })).rejects.toThrow('provider down')

    expect(insert_call()).toBeUndefined()
  })
})

describe('get_otp_cooldown', () => {
  function use_cooldown_row(cooldown_until: string | null) {
    mocks.db.execute.mockResolvedValue([cooldown_until ? [{ cooldown_until }] : [], []])
  }

  it('allows sending when the device has no history', async () => {
    use_cooldown_row(null)

    await expect(get_otp_cooldown({ identity_token: DEVICE })).resolves.toEqual({ can_send: true, next_available_at: null })
  })

  it('reports the remaining cooldown while one is open', async () => {
    use_cooldown_row('2026-09-11T08:00:30.000Z')

    await expect(get_otp_cooldown({ identity_token: DEVICE })).resolves.toEqual({
      can_send: false,
      next_available_at: '2026-09-11T08:00:30.000Z',
    })
  })

  it('allows sending again once the cooldown has elapsed', async () => {
    use_cooldown_row('2026-09-11T07:59:00.000Z')

    await expect(get_otp_cooldown({ identity_token: DEVICE })).resolves.toEqual({ can_send: true, next_available_at: null })
  })

  it('also matches the phone number when one is given', async () => {
    use_cooldown_row(null)

    await get_otp_cooldown({ identity_token: DEVICE, phone: PHONE })

    const [sql, params] = mocks.db.execute.mock.calls[0] as [string, unknown[]]
    expect(sql).toContain('(identity_token = ? OR phone = ?)')
    expect(params).toEqual([DEVICE, PHONE])
  })

  it('matches only the device when no phone is given', async () => {
    use_cooldown_row(null)

    await get_otp_cooldown({ identity_token: DEVICE })

    const [sql, params] = mocks.db.execute.mock.calls[0] as [string, unknown[]]
    expect(sql).not.toContain('phone = ?')
    expect(params).toEqual([DEVICE])
  })
})

describe('send_otp_for_request', () => {
  const captcha = { lot_number: 'lot', captcha_output: 'out', pass_token: 'pass', gen_time: '1' }

  it('verifies the captcha before doing anything else', async () => {
    mocks.captcha.verify_captcha.mockRejectedValue(new Error('captcha rejected'))

    await expect(send_otp_for_request(create_event(), { ... captcha, phone: PHONE, purpose: 'login' }, DEVICE))
      .rejects.toThrow('captcha rejected')

    expect(mocks.captcha.verify_captcha).toHaveBeenCalledWith({ ... captcha, phone: PHONE, purpose: 'login' })
    expect(mocks.sms.send_otp_sms).not.toHaveBeenCalled()
  })

  it('sends to the phone in the request for a public purpose', async () => {
    await send_otp_for_request(create_event(), { ... captcha, phone: PHONE, purpose: 'login' }, DEVICE)

    expect(mocks.guards.require_auth_user).not.toHaveBeenCalled()
    expect(mocks.sms.send_otp_sms).toHaveBeenCalledWith({ phone: PHONE, out_id: expect.any(String) })
  })

  it.each(['change_password', 'verify_old_phone'])('ignores the request body and targets the signed-in phone for %s', async (purpose) => {
    await send_otp_for_request(create_event(), { ... captcha, phone: '13900139000', purpose }, DEVICE)

    expect(mocks.guards.require_auth_user).toHaveBeenCalled()
    expect(mocks.sms.send_otp_sms).toHaveBeenCalledWith({ phone: PHONE, out_id: expect.any(String) })
  })

  it('rejects an invalid phone before calling the provider', async () => {
    await expect(send_otp_for_request(create_event(), { ... captcha, phone: '12345', purpose: 'login' }, DEVICE)).rejects.toThrow()

    expect(mocks.sms.send_otp_sms).not.toHaveBeenCalled()
  })

  it('broadcasts both cooldown resources so every tab settles its timer', async () => {
    await send_otp_for_request(create_event(), { ... captcha, phone: PHONE, purpose: 'login' }, DEVICE)

    expect(mocks.sync.publish_refresh).toHaveBeenCalledWith({ resource: `otp_cooldown:${PHONE}` })
    expect(mocks.sync.publish_refresh).toHaveBeenCalledWith({ resource: `otp_cooldown_by_identity:${DEVICE}` })
  })
})

describe('login_with_password token issuance', () => {
  const payload = { username_or_phone: 'tester', password: 'secret' }

  function use_user(password_hash: string, overrides: Record<string, unknown> = {}) {
    mocks.db.execute.mockImplementation(async (sql: string) => {
      if (String(sql).includes('SELECT id, password_hash')) {
        return [[{ id: 7, password_hash, is_banned: 0, ... overrides }], []]
      }
      return [[{
        id: 7,
        username: 'tester',
        phone: PHONE,
        avatar_file: null,
        avatar_version: null,
        is_verified: 1,
        is_admin: 0,
      }], []]
    })
  }

  it('rejects an unknown account without touching the session tables', async () => {
    mocks.db.execute.mockResolvedValue([[], []])

    await expect(login_with_password(create_event(), payload, create_device_context(), DEVICE))
      .rejects.toMatchObject({ statusCode: 401, message: '用户名或密码错误' })

    expect(mocks.sessions.create_login_session).not.toHaveBeenCalled()
  })

  it('rejects a disabled account before comparing the password', async () => {
    use_user('irrelevant', { is_banned: 1 })

    await expect(login_with_password(create_event(), payload, create_device_context(), DEVICE))
      .rejects.toMatchObject({ statusCode: 401, message: '账号已被禁用' })

    expect(mocks.sessions.create_login_session).not.toHaveBeenCalled()
  })

  it('rejects a wrong password', async () => {
    use_user(bcrypt.hashSync('another-secret', 4))

    await expect(login_with_password(create_event(), payload, create_device_context(), DEVICE))
      .rejects.toMatchObject({ statusCode: 401, message: '用户名或密码错误' })

    expect(mocks.sessions.create_login_session).not.toHaveBeenCalled()
  })

  it('issues a cookie-backed session and never returns the token in the body', async () => {
    use_user(bcrypt.hashSync('secret', 4))

    const result = await login_with_password(create_event(), payload, create_device_context(), DEVICE)

    expect(mocks.session_lib.sign_auth_token).toHaveBeenCalledWith(7)
    // The stored generation must be the hash of the token in the cookie, so the
    // next request can find it.
    expect(mocks.sessions.create_login_session).toHaveBeenCalledWith(
      7,
      { hash: 'token-hash', exp: 1_900_000_000 },
      DEVICE,
      expect.objectContaining({ user_agent: 'vitest' }),
    )
    expect(mocks.session_lib.set_auth_token_cookie).toHaveBeenCalledWith(expect.anything(), 'issued-token')
    expect(mocks.sync.publish_refresh).toHaveBeenCalledWith({ resource: 'profile_sessions:7' })
    expect(result).toEqual({
      user: {
        id: 7,
        username: 'tester',
        phone: PHONE,
        avatar_file: null,
        avatar_version: null,
        is_verified: true,
        is_admin: false,
        permissions: [],
      },
    })
    expect(JSON.stringify(result)).not.toContain('issued-token')
  })
})

describe('register_user token issuance', () => {
  const payload = { username: 'newbie', phone: PHONE, password: 'secret', otp: '123456' }

  it('refuses a duplicate username or phone and leaves no session behind', async () => {
    mocks.db.execute.mockResolvedValue([[{ id: 9 }], []])

    await expect(register_user(create_event(), payload, create_device_context(), DEVICE))
      .rejects.toMatchObject({ statusCode: 409, message: '用户名或手机号已存在' })

    expect(mocks.sessions.create_login_session).not.toHaveBeenCalled()
  })

  it('inserts the user and immediately issues a session', async () => {
    mocks.db.execute.mockImplementation(async (sql: string) => {
      if (String(sql).includes('SELECT id FROM users')) {
        return [[], []]
      }
      if (String(sql).includes('INSERT INTO users')) {
        return [{ insertId: 77, affectedRows: 1 }, []]
      }
      return [[{
        id: 77,
        username: 'newbie',
        phone: PHONE,
        avatar_file: null,
        avatar_version: null,
        is_verified: 0,
        is_admin: 0,
      }], []]
    })

    const result = await register_user(create_event(), payload, create_device_context(), DEVICE)

    expect(mocks.sms.check_otp_sms).toHaveBeenCalledWith({ phone: PHONE, code: '123456' })
    expect(mocks.sessions.create_login_session).toHaveBeenCalledWith(77, expect.any(Object), DEVICE, expect.any(Object))
    expect(result.user).toMatchObject({ id: 77, is_verified: false })

    const insert = mocks.db.execute.mock.calls.find(call => String(call[0]).includes('INSERT INTO users'))!
    // Never store the plaintext password.
    expect(insert[1]?.[2]).not.toBe('secret')
    expect(String(insert[1]?.[2])).toMatch(/^\$2[aby]\$/)
  })
})

describe('login_with_phone token issuance', () => {
  const payload = { phone: PHONE, otp: '123456' }

  function use_phone_lookup(rows: Record<string, unknown>[]) {
    mocks.db.execute.mockImplementation(async (sql: string) => {
      if (String(sql).includes('SELECT id, is_banned FROM users WHERE phone')) {
        return [rows, []]
      }
      return [[{
        id: 7,
        username: 'tester',
        phone: PHONE,
        avatar_file: null,
        avatar_version: null,
        is_verified: 1,
        is_admin: 0,
      }], []]
    })
  }

  it('checks the code before looking the account up', async () => {
    mocks.sms.check_otp_sms.mockRejectedValue(new Error('验证码不正确'))

    await expect(login_with_phone(create_event(), payload, create_device_context(), DEVICE))
      .rejects.toThrow('验证码不正确')

    expect(mocks.sessions.create_login_session).not.toHaveBeenCalled()
  })

  it('rejects an unregistered phone without issuing a session', async () => {
    use_phone_lookup([])

    await expect(login_with_phone(create_event(), payload, create_device_context(), DEVICE))
      .rejects.toMatchObject({ statusCode: 401, message: '手机号未注册' })

    expect(mocks.sessions.create_login_session).not.toHaveBeenCalled()
  })

  it('rejects a disabled account', async () => {
    use_phone_lookup([{ id: 7, is_banned: 1 }])

    await expect(login_with_phone(create_event(), payload, create_device_context(), DEVICE))
      .rejects.toMatchObject({ statusCode: 401, message: '账号已被禁用' })

    expect(mocks.sessions.create_login_session).not.toHaveBeenCalled()
  })

  it('issues a cookie-backed session without returning the token', async () => {
    use_phone_lookup([{ id: 7, is_banned: 0 }])

    const result = await login_with_phone(create_event(), payload, create_device_context(), DEVICE)

    expect(mocks.sms.check_otp_sms).toHaveBeenCalledWith({ phone: PHONE, code: '123456' })
    expect(mocks.session_lib.set_auth_token_cookie).toHaveBeenCalledWith(expect.anything(), 'issued-token')
    expect(mocks.sessions.create_login_session).toHaveBeenCalledWith(
      7,
      { hash: 'token-hash', exp: 1_900_000_000 },
      DEVICE,
      expect.objectContaining({ user_agent: 'vitest' }),
    )
    expect(result).toEqual({
      user: {
        id: 7,
        username: 'tester',
        phone: PHONE,
        avatar_file: null,
        avatar_version: null,
        is_verified: true,
        is_admin: false,
        permissions: [],
      },
    })
    expect(JSON.stringify(result)).not.toContain('issued-token')
  })
})

describe('logout_user', () => {
  it('ends the session, clears the cookie and refreshes dependent clients', async () => {
    await logout_user(create_event(), {
      id: 7,
      session_id: 11,
      username: 'tester',
      phone: PHONE,
      avatar_file: null,
      is_verified: true,
      is_admin: false,
    })

    expect(mocks.sessions.logout_session).toHaveBeenCalledWith(11)
    expect(mocks.session_lib.clear_auth_token_cookie).toHaveBeenCalled()
    expect(mocks.sync.publish_refresh).toHaveBeenCalledWith({ resource: 'profile_sessions:7' })
    expect(mocks.sync.publish_refresh).toHaveBeenCalledWith({ resource: 'auth_user:7' })
  })
})
