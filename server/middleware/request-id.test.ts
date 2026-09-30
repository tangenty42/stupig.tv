import { describe, expect, it, vi } from 'vitest'

vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
vi.stubGlobal('getRequestHeader', () => undefined)
vi.stubGlobal('setResponseHeader', () => {})

const { resolve_request_id } = await import('@server/middleware/request-id')

describe('resolve_request_id', () => {
  it('keeps a well-formed incoming id so requests can be traced across services', () => {
    expect(resolve_request_id('req-abc-123')).toBe('req-abc-123')
  })

  it('generates a fresh id when the header is missing', () => {
    const id = resolve_request_id(undefined)

    expect(id).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('rejects oversized or newline-injected ids that would pollute log lines', () => {
    expect(resolve_request_id('x'.repeat(65))).not.toBe('x'.repeat(65))
    expect(resolve_request_id('ok\nforged-log-line')).not.toContain('\n')
  })
})
