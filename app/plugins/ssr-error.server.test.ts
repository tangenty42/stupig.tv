import { afterEach, describe, expect, it, vi } from 'vitest'

vi.stubGlobal('defineNuxtPlugin', <Plugin>(plugin: Plugin) => plugin)
const { default: plugin } = await import('./ssr-error.server')

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('sSR error logging', () => {
  it('logs the original app error with request context before rendering fails', () => {
    const output = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.stubGlobal('useRequestEvent', () => ({
      context: { request_id: 'request-123' },
      path: '/',
    }))
    const error = new Error('Plugin setup failed')

    plugin.hooks!['app:error']!(error)

    expect(output).toHaveBeenCalledTimes(1)
    expect(JSON.parse(output.mock.calls[0]![0])).toMatchObject({
      level: 'error',
      msg: 'SSR app error',
      request_id: 'request-123',
      path: '/',
      error_class: 'Error',
      error_message: error.message,
      stack: error.stack,
    })
  })

  it('does not throw when request context is unavailable', () => {
    const output = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.stubGlobal('useRequestEvent', () => undefined)

    expect(() => plugin.hooks!['app:error']!('setup failed')).not.toThrow()

    expect(output).toHaveBeenCalledTimes(1)
    expect(JSON.parse(output.mock.calls[0]![0])).toMatchObject({
      msg: 'SSR app error',
      error_class: 'string',
      error_message: 'setup failed',
    })
  })
})
