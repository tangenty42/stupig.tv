import type { H3Event } from 'h3'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ execute: vi.fn(), status: vi.fn() }))
vi.mock('@server/lib/db', () => ({ db: { execute: state.execute } }))
vi.mock('@server/lib/log', () => ({ log_error: () => {}, error_fields: () => ({}) }))
vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
const handler = (await import('./healthz.get')).default

beforeEach(() => {
  state.execute.mockReset()
  state.status.mockReset()
  vi.stubGlobal('setResponseStatus', state.status)
})

describe('migration ledger readiness', () => {
  it('只查询统一账本已完成记录，旧表无需存在', async () => {
    state.execute.mockResolvedValue([[{ applied: 21 }], []])
    await expect(handler({} as H3Event)).resolves.toEqual({ status: 'ok', migrations: 21 })
    expect(state.execute).toHaveBeenCalledWith('SELECT COUNT(*) AS applied FROM migration_runs WHERE status = \'completed\'')
    expect(state.status).not.toHaveBeenCalled()
  })

  it('新账本不可用时返回 503，不回退旧表', async () => {
    state.execute.mockRejectedValue(new Error('unavailable'))
    await expect(handler({} as H3Event)).resolves.toEqual({ status: 'unavailable' })
    expect(state.status).toHaveBeenCalledWith(expect.anything(), 503)
    expect(state.execute).toHaveBeenCalledTimes(1)
  })
})
