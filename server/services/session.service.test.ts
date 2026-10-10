import type { H3Event } from 'h3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  config: {
    app: {
      auth: {
        jwt: { secret: 'unit-test-secret-with-at-least-32-characters', expiresInDays: 30 },
        cookie: { tokenName: 'auth_token', userName: 'auth_user', maxAgeDays: 45 },
        session: { maxAgeDays: 14, maxTokenGenerations: 5 },
      },
      online: { timeoutSeconds: 300 },
    },
  },
}))

vi.mock('@config/loader', () => ({ runtime_config: () => mocks.config }))

const db_holder = vi.hoisted(() => ({
  db: { getConnection: vi.fn(), execute: vi.fn() },
}))

vi.mock('@server/lib/db', () => ({ db: db_holder.db }))

interface FakeToken {
  id: number
  session_id: number
}

interface FakeDbOptions {
  /** Session row the device already has, if any. */
  reusable_session_id?: number | null
  is_reusable?: boolean
  tokens?: FakeToken[]
  /** SQL fragment that should be treated as a storage failure. */
  fail_on?: string
}

const NEW_SESSION_ID = 555

function create_fake_db(options: FakeDbOptions = {}) {
  const calls: Array<{ sql: string, params: unknown[] }> = []
  const tokens = [... (options.tokens ?? [])]
  let next_token_id = Math.max(0, ... tokens.map(token => token.id)) + 1
  const state = { committed: 0, rolled_back: 0, released: 0 }

  function take_token_id() {
    const id = next_token_id
    next_token_id += 1
    return id
  }

  const execute = vi.fn(async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params })

    if (options.fail_on && sql.includes(options.fail_on)) {
      throw new Error(`injected failure: ${options.fail_on}`)
    }

    if (sql.includes('AS is_reusable')) {
      return [options.reusable_session_id
        ? [{ id: options.reusable_session_id, is_reusable: options.is_reusable ? 1 : 0 }]
        : []]
    }

    if (sql.includes('INSERT INTO user_login_sessions')) {
      return [{ insertId: NEW_SESSION_ID, affectedRows: 1 }, []]
    }

    // The append guard: only a generation with nothing newer behind it lands.
    // The comparison direction is read from the SQL rather than hardcoded, so
    // inverting it in the service fails here instead of being mirrored back.
    if (sql.includes('WHERE NOT EXISTS')) {
      const [session_id, , , , presented_generation_id] = params as [number, string, Date, number, number]
      const operator = sql.match(/id\s*([<>])\s*\?/)?.[1] ?? '>'
      const blocked = tokens.some(token => token.session_id === session_id
        && (operator === '>' ? token.id > presented_generation_id : token.id < presented_generation_id))
      if (blocked) {
        return [{ affectedRows: 0 }, []]
      }
      tokens.push({ id: take_token_id(), session_id })
      return [{ affectedRows: 1 }, []]
    }

    // The trim keeps the newest N generations per session. Direction and limit
    // also come from the SQL, so flipping DESC to ASC (which would retain the
    // oldest and evict the live one) is caught.
    if (sql.includes('id NOT IN')) {
      const session_id = params[0] as number
      const limit = Number(sql.match(/LIMIT\s+(\d+)/)?.[1] ?? Number.POSITIVE_INFINITY)
      const descending = /ORDER BY\s+id\s+DESC/i.test(sql)
      const mine = tokens.filter(token => token.session_id === session_id)
        .sort((left, right) => (descending ? right.id - left.id : left.id - right.id))
      const kept = new Set(mine.slice(0, limit).map(token => token.id))
      let removed = 0
      for (let index = tokens.length - 1; index >= 0; index -= 1) {
        const token = tokens[index]!
        if (token.session_id === session_id && ! kept.has(token.id)) {
          tokens.splice(index, 1)
          removed += 1
        }
      }
      return [{ affectedRows: removed }, []]
    }

    // Plain delete drops the generations a re-login revokes.
    if (sql.includes('DELETE FROM user_login_session_tokens')) {
      const session_id = params[0] as number
      const removed = tokens.filter(token => token.session_id === session_id).length
      for (let index = tokens.length - 1; index >= 0; index -= 1) {
        if (tokens[index]!.session_id === session_id) {
          tokens.splice(index, 1)
        }
      }
      return [{ affectedRows: removed }, []]
    }

    if (sql.includes('INSERT INTO user_login_session_tokens')) {
      const id = take_token_id()
      tokens.push({ id, session_id: params[0] as number })
      return [{ insertId: id, affectedRows: 1 }, []]
    }

    return [{ affectedRows: 1 }, []]
  })

  const connection = {
    beginTransaction: vi.fn(async () => {}),
    commit: vi.fn(async () => {
      state.committed += 1
    }),
    rollback: vi.fn(async () => {
      state.rolled_back += 1
    }),
    release: vi.fn(() => {
      state.released += 1
    }),
    execute,
  }

  return {
    db: { getConnection: vi.fn(async () => connection), execute },
    connection,
    calls,
    tokens,
    state,
    find: (fragment: string) => calls.filter(call => call.sql.includes(fragment)),
    last: (fragment: string) => calls.filter(call => call.sql.includes(fragment)).at(- 1),
  }
}

const get_header = vi.fn()
vi.stubGlobal('getHeader', get_header)

const { create_login_session, get_login_sessions, get_request_device_context, logout_all_user_sessions, logout_session, refresh_login_session } = await import('@server/services/session.service')

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-09-11T08:00:00Z'))
  get_header.mockReset()
  get_header.mockReturnValue(undefined)
})

afterEach(() => {
  vi.useRealTimers()
})

async function use_fake_db(options: FakeDbOptions = {}) {
  const fake = create_fake_db(options)
  db_holder.db.getConnection = fake.db.getConnection
  db_holder.db.execute = fake.db.execute
  return fake
}

describe('create_login_session', () => {
  const device = { login_ip: '203.0.113.1', last_seen_ip: '203.0.113.1', user_agent: 'vitest' }

  it('inserts a session and its first token generation in one transaction', async () => {
    const fake = await use_fake_db()
    const now = Date.now()

    await create_login_session(7, { hash: 'hash-1', exp: 1_800_000_000 }, 'device-a', device)

    expect(fake.find('INSERT INTO user_login_sessions')).toHaveLength(1)
    expect(fake.last('INSERT INTO user_login_sessions')!.params).toEqual([
      7,
      'device-a',
      new Date(now + mocks.config.app.auth.session.maxAgeDays * 86_400_000),
      '203.0.113.1',
      '203.0.113.1',
      'vitest',
    ])

    expect(fake.last('INSERT INTO user_login_session_tokens')!.params).toEqual([
      NEW_SESSION_ID,
      'hash-1',
      new Date(1_800_000_000_000),
    ])

    expect(fake.state).toMatchObject({ committed: 1, rolled_back: 0, released: 1 })
  })

  it('revives the latest inactive session for the device and drops its old generations', async () => {
    const fake = await use_fake_db({ reusable_session_id: 321, is_reusable: true, tokens: [{ id: 1, session_id: 321 }] })

    await create_login_session(7, { hash: 'hash-2', exp: 1_800_000_000 }, 'device-a', device)

    expect(fake.find('INSERT INTO user_login_sessions')).toHaveLength(0)

    expect(fake.last('UPDATE user_login_sessions')!.params.at(- 1)).toBe(321)

    // Logging in again revokes every generation this device held before, so the
    // old token can never be replayed.
    expect(fake.find('DELETE FROM user_login_session_tokens WHERE session_id = ?')).toHaveLength(1)
    expect(fake.tokens).toEqual([{ id: expect.any(Number), session_id: 321 }])
    expect(fake.last('INSERT INTO user_login_session_tokens')!.params[0]).toBe(321)

    expect(fake.state).toMatchObject({ committed: 1, rolled_back: 0, released: 1 })
  })

  it('starts a fresh session when the device already has a live one', async () => {
    const fake = await use_fake_db({ reusable_session_id: 321, is_reusable: false })

    await create_login_session(7, { hash: 'hash-3', exp: 1_800_000_000 }, 'device-a', device)

    expect(fake.find('INSERT INTO user_login_sessions')).toHaveLength(1)
    expect(fake.find('DELETE FROM user_login_session_tokens')).toHaveLength(0)
    expect(fake.last('INSERT INTO user_login_session_tokens')!.params[0]).toBe(NEW_SESSION_ID)
  })

  it('rolls back and releases the connection when the session write fails', async () => {
    const fake = await use_fake_db({ fail_on: 'INSERT INTO user_login_sessions' })

    await expect(create_login_session(7, { hash: 'hash', exp: 1_800_000_000 }, 'device-a', device)).rejects.toThrow('injected failure')

    expect(fake.state).toMatchObject({ committed: 0, rolled_back: 1, released: 1 })
  })

  it('rolls back and releases the connection when the token write fails', async () => {
    const fake = await use_fake_db({ fail_on: 'INSERT INTO user_login_session_tokens' })

    await expect(create_login_session(7, { hash: 'hash', exp: 1_800_000_000 }, 'device-a', device)).rejects.toThrow('injected failure')

    expect(fake.state).toMatchObject({ committed: 0, rolled_back: 1, released: 1 })
  })
})

describe('refresh_login_session', () => {
  const next = { hash: 'new-hash', exp: 1_800_000_000 }

  it('slides the idle window without appending when no renewal is due', async () => {
    const fake = await use_fake_db({ tokens: [{ id: 10, session_id: 5 }] })

    const applied = await refresh_login_session({
      session_id: 5,
      presented_generation_id: 10,
      next: null,
      last_seen_ip: '203.0.113.1',
    })

    expect(applied).toBe(false)
    expect(fake.last('UPDATE user_login_sessions')!.params).toEqual(['203.0.113.1', mocks.config.app.auth.session.maxAgeDays, 5])
    expect(fake.find('WHERE NOT EXISTS')).toHaveLength(0)
    // The trim still runs: a session whose cookie never updates must not grow
    // its generation family without bound.
    expect(fake.find('expires_at <= NOW()')).toHaveLength(1)
    expect(fake.state).toMatchObject({ committed: 1, rolled_back: 0, released: 1 })
  })

  it('re-anchors the idle window to now instead of extending the old deadline', async () => {
    const fake = await use_fake_db({ tokens: [{ id: 10, session_id: 5 }] })

    await refresh_login_session({ session_id: 5, presented_generation_id: 10, next: null, last_seen_ip: null })

    // `expires_at = expires_at + INTERVAL ? DAY` would roll the deadline forward
    // on every request, so the session could never actually go idle.
    const slide = fake.find('UPDATE user_login_sessions')[0]!
    expect(slide.sql).toContain('expires_at = NOW() + INTERVAL ? DAY')
  })

  it('appends a generation and reports it applied', async () => {
    const fake = await use_fake_db({ tokens: [{ id: 10, session_id: 5 }] })

    const applied = await refresh_login_session({
      session_id: 5,
      presented_generation_id: 10,
      next,
      last_seen_ip: null,
    })

    expect(applied).toBe(true)
    expect(fake.last('WHERE NOT EXISTS')!.params).toEqual([5, 'new-hash', new Date(1_800_000_000_000), 5, 10])
    expect(fake.tokens).toHaveLength(2)
  })

  it('refuses to append when a newer generation already exists', async () => {
    const fake = await use_fake_db({ tokens: [{ id: 10, session_id: 5 }, { id: 11, session_id: 5 }] })

    const applied = await refresh_login_session({
      session_id: 5,
      presented_generation_id: 10,
      next,
      last_seen_ip: null,
    })

    expect(applied).toBe(false)
    expect(fake.tokens).toHaveLength(2)
  })

  it('lets exactly one of two concurrent renewals of the same generation win', async () => {
    const fake = await use_fake_db({ tokens: [{ id: 10, session_id: 5 }] })

    const [first, second] = await Promise.all([
      refresh_login_session({ session_id: 5, presented_generation_id: 10, next, last_seen_ip: null }),
      refresh_login_session({ session_id: 5, presented_generation_id: 10, next, last_seen_ip: null }),
    ])

    // The loser wrote nothing, so its signed token has no row and must not be
    // handed to the browser.
    expect([first, second].sort()).toEqual([false, true])
    expect(fake.tokens).toHaveLength(2)
  })

  it('bounds the family to the newest generations, keeping the one just issued', async () => {
    const limit = mocks.config.app.auth.session.maxTokenGenerations
    // One generation per id, all belonging to this session, so the trim has to
    // pick which end of the range to keep.
    const fake = await use_fake_db({
      tokens: Array.from({ length: limit + 5 }, (_, index) => ({ id: index + 1, session_id: 5 })),
    })

    await refresh_login_session({ session_id: 5, presented_generation_id: limit + 5, next, last_seen_ip: null })

    const issued_id = limit + 6
    expect(fake.tokens).toHaveLength(limit)
    // The live generation and the ones just behind it survive; the oldest are
    // evicted. Asserting the ids, not the length, is what catches a reversed
    // ORDER BY: keeping the oldest would still leave `limit` rows behind.
    expect(fake.tokens.map(token => token.id).sort((left, right) => left - right))
      .toEqual(Array.from({ length: limit }, (_, index) => issued_id - index).sort((left, right) => left - right))
    expect(fake.tokens.some(token => token.id === 1)).toBe(false)

    const trim = fake.last('expires_at <= NOW()')!
    expect(trim.sql).toContain(`LIMIT ${limit}`)
    expect(trim.sql).toContain('id NOT IN')
    expect(trim.params).toEqual([5, 5])
  })

  it('leaves other sessions out of the trim', async () => {
    const fake = await use_fake_db({
      tokens: Array.from({ length: 20 }, (_, index) => ({ id: index + 1, session_id: 5 }))
        .concat(Array.from({ length: 20 }, (_, index) => ({ id: index + 100, session_id: 6 }))),
    })

    await refresh_login_session({ session_id: 5, presented_generation_id: 20, next, last_seen_ip: null })

    expect(fake.tokens.filter(token => token.session_id === 6)).toHaveLength(20)
  })

  it('rolls back and releases the connection when the trim fails', async () => {
    const fake = await use_fake_db({ fail_on: 'expires_at <= NOW()' })

    await expect(refresh_login_session({ session_id: 5, presented_generation_id: 10, next, last_seen_ip: null })).rejects.toThrow('injected failure')

    expect(fake.state).toMatchObject({ committed: 0, rolled_back: 1, released: 1 })
  })
})

describe('get_login_sessions', () => {
  /** One raw row as the SELECT would return it (flags still as tinyint). */
  function session_row(overrides: Record<string, unknown> = {}) {
    return {
      id: 11,
      user_id: 7,
      identity_token: 'device-a',
      is_logged_out: 0,
      is_expired: 0,
      is_online: 1,
      is_current: 1,
      login_at: '2026-09-11T07:00:00.000Z',
      last_seen_at: '2026-09-11T08:00:00.000Z',
      logout_at: null,
      expires_at: '2026-09-25T08:00:00.000Z',
      login_ip: '203.0.113.1',
      last_seen_ip: '203.0.113.1',
      user_agent: 'vitest',
      ... overrides,
    }
  }

  function use_rows(rows: Record<string, unknown>[]) {
    const execute = vi.fn(async () => [rows, []])
    db_holder.db.execute = execute as unknown as typeof db_holder.db.execute
    return execute
  }

  it('converts the tinyint flags the client renders', async () => {
    use_rows([session_row({ is_logged_out: 1, is_expired: 0, is_online: 0, is_current: 0 })])

    const { records } = await get_login_sessions(7, 11)

    expect(records[0]).toMatchObject({
      is_logged_out: true,
      is_expired: false,
      is_online: false,
      is_current: false,
    })
  })

  it('identifies the caller session by id and passes the idle timeout to the query', async () => {
    const execute = use_rows([session_row()])

    await get_login_sessions(7, 11)

    const [sql, params] = execute.mock.calls[0] as unknown as [string, unknown[]]
    // is_current is computed from the session id; it must not be resolved from a
    // token hash, which the client can read.
    expect(sql).toContain('(id <=> ?) AS is_current')
    expect(sql).not.toContain('token_hash')
    expect(params).toEqual([mocks.config.app.online.timeoutSeconds, 11, 7, mocks.config.app.online.timeoutSeconds])
  })

  it('leaves every session unmarked when no current session is given', async () => {
    const execute = use_rows([session_row({ is_current: 0 })])

    const { records } = await get_login_sessions(7, null)

    expect((execute.mock.calls[0] as unknown as [string, unknown[]])[1]![1]).toBeNull()
    expect(records.every(record => record.is_current === false)).toBe(true)
  })

  it('never exposes a token hash to the caller', async () => {
    use_rows([session_row()])

    const { records } = await get_login_sessions(7, 11)

    expect(records[0]).not.toHaveProperty('token_hash')
  })
})

describe('logout_session', () => {
  it('marks only the presented session as logged out', async () => {
    const fake = await use_fake_db()

    await logout_session(5)

    const logout = fake.last('UPDATE user_login_sessions SET is_logged_out = 1, logout_at = NOW()')!
    expect(logout.params).toEqual([5])
  })

  it('can log out every session of a user at once', async () => {
    const fake = await use_fake_db()

    await logout_all_user_sessions(7)

    const logout = fake.last('WHERE user_id = ?')!
    expect(logout.sql).toContain('is_logged_out = 1')
    expect(logout.params).toEqual([7])
  })
})

describe('get_request_device_context', () => {
  it('records the user agent, login ip and last seen ip from the request', () => {
    get_header.mockImplementation((_event: H3Event, name: string) => (name === 'user-agent' ? 'vitest-agent' : undefined))

    const event = { node: { req: { socket: { remoteAddress: '192.168.1.5' } } } } as unknown as H3Event

    expect(get_request_device_context(event)).toEqual({
      login_ip: '192.168.1.5',
      last_seen_ip: '192.168.1.5',
      user_agent: 'vitest-agent',
    })
  })

  it('falls back to the forwarded address for the client ip', () => {
    get_header.mockImplementation((_event: H3Event, name: string) => (name === 'x-forwarded-for' ? '203.0.113.9, 10.0.0.1' : undefined))

    const event = { node: { req: { socket: { remoteAddress: '192.168.1.5' } } } } as unknown as H3Event

    expect(get_request_device_context(event)).toMatchObject({ login_ip: '203.0.113.9', user_agent: null })
  })
})
