import { EventEmitter } from 'node:events'
import { expect, it, vi } from 'vitest'

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('node:child_process', () => ({ spawn }))
const { start_dev_esa_notice } = await import('./esa-notice')

it('starts the read-only notice in a child that can be stopped independently', () => {
  const child = Object.assign(new EventEmitter(), { kill: vi.fn() })
  spawn.mockReturnValueOnce(child)
  const env = { NODE_ENV: 'development', DEV_TEST: 'selected-env' }
  const stop = start_dev_esa_notice(env)
  expect(spawn).toHaveBeenCalledWith(process.execPath, expect.arrayContaining(['--import', 'tsx']), expect.objectContaining({ env, windowsHide: true }))
  stop()
  expect(child.kill).toHaveBeenCalledOnce()
})

it('does not throw when the check process cannot be started', () => {
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
  try {
    spawn.mockImplementationOnce(() => {
      throw new Error('private diagnostic')
    })
    expect(() => start_dev_esa_notice({ NODE_ENV: 'development' })()).not.toThrow()
    expect(warning).toHaveBeenCalledOnce()
    expect(String(warning.mock.calls[0]?.[0])).not.toContain('private diagnostic')
  }
  finally { warning.mockRestore() }
})
