import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { supervise_child } from './process.mjs'

afterEach(() => vi.useRealTimers())

describe('development child lifecycle', () => {
  it('restarts once after error plus exit, and cancels retry on shutdown', () => {
    vi.useFakeTimers()
    const child = Object.assign(new EventEmitter(), { kill: vi.fn() })
    const spawn = vi.fn(() => child)
    const stop = supervise_child('frpc', [], { spawn })
    child.emit('error', new Error('failed'))
    child.emit('exit', 1)
    vi.advanceTimersByTime(5000)
    expect(spawn).toHaveBeenCalledTimes(2)
    child.emit('exit', 1)
    stop()
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(10000)
    expect(spawn).toHaveBeenCalledTimes(2)
  })

  it('stops its own child without restarting after its exit', () => {
    vi.useFakeTimers()
    const child = Object.assign(new EventEmitter(), { kill: vi.fn() })
    const spawn = vi.fn(() => child)
    const stop = supervise_child('frpc', [], { spawn })
    stop()
    child.emit('exit', 0)
    vi.advanceTimersByTime(10000)
    expect(child.kill).toHaveBeenCalledOnce()
    expect(spawn).toHaveBeenCalledOnce()
    expect(spawn.mock.calls[0]).toEqual(['frpc', [], expect.objectContaining({ windowsHide: true })])
  })
})
