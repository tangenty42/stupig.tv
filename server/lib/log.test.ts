import { error_fields, log_error, log_info, log_warn } from '@server/lib/log'
import { beforeEach, describe, expect, it, vi } from 'vitest'

describe('structured logging', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('writes one JSON line with level, msg and custom fields', () => {
    const log_spy = vi.spyOn(console, 'log').mockImplementation(() => {})

    log_info('mqtt-publish-dropped', { resource: 'profile:1', dropped_total: 3 })

    expect(log_spy).toHaveBeenCalledOnce()
    const line = JSON.parse(log_spy.mock.calls[0]![0] as string)
    expect(line).toMatchObject({
      level: 'info',
      msg: 'mqtt-publish-dropped',
      resource: 'profile:1',
      dropped_total: 3,
    })
    expect(typeof line.time).toBe('string')
  })

  it('routes warn and error to the matching console methods', () => {
    const warn_spy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const error_spy = vi.spyOn(console, 'error').mockImplementation(() => {})

    log_warn('cache write failed')
    log_error('unhandled error')

    expect(JSON.parse(warn_spy.mock.calls[0]![0] as string).level).toBe('warn')
    expect(JSON.parse(error_spy.mock.calls[0]![0] as string).level).toBe('error')
  })
})

describe('error_fields', () => {
  it('serializes Error instances with class, message and stack', () => {
    const fields = error_fields(new TypeError('bad input'))

    expect(fields.error_class).toBe('TypeError')
    expect(fields.error_message).toBe('bad input')
    expect(typeof fields.stack).toBe('string')
  })

  it('serializes non-Error throws without crashing', () => {
    expect(error_fields('boom')).toEqual({ error_class: 'string', error_message: 'boom' })
  })
})
