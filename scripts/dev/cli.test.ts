import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), tunnel: vi.fn(), config: vi.fn(), notice: vi.fn() }))
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }))
vi.mock('./frp', () => ({ run_dev_tunnel: mocks.tunnel }))
vi.mock('./auth-config', () => ({ load_dev_auth_config: mocks.config }))
vi.mock('./esa-notice', () => ({ start_dev_esa_notice: mocks.notice }))
// Keep failure diffs isolated from the developer's real env files and credentials.
vi.mock('../../config/lib/environment.mjs', () => ({ load_environment: () => ({ NODE_ENV: 'development' }) }))
const { run_development } = await import('./cli')
afterEach(() => vi.resetAllMocks())

it('starts the standalone app on loopback by default', () => {
  const scripts = JSON.parse(readFileSync('package.json', 'utf8')).scripts as Record<string, string>
  expect(scripts['dev:app']).toContain('--host 127.0.0.1')
})

async function reserve_port(host = '127.0.0.1') {
  const server = createServer()
  await new Promise<void>(resolve => server.listen(0, host, resolve))
  const address = server.address()
  if (! address || typeof address === 'string')
    throw new Error('Expected TCP address')
  mocks.config.mockReturnValue({ proxy: { targetHost: '127.0.0.1', targetPort: address.port } })
  const close = () => new Promise<void>(resolve => server.close(() => resolve()))
  return { close, port: address.port }
}

it.each(['127.0.0.1', '0.0.0.0'])('refuses a running app on %s without starting a second app or tunnel', async (host) => {
  const reservation = await reserve_port(host)
  try {
    await expect(run_development()).rejects.toThrow('port is occupied')
    expect(mocks.spawn).not.toHaveBeenCalled()
    expect(mocks.tunnel).not.toHaveBeenCalled()
    expect(mocks.notice).not.toHaveBeenCalled()
  }
  finally { await reservation.close() }
})

it.each(['exit', 'error', 'stop'] as const)('releases owned tunnel and app on %s', async (event) => {
  const reservation = await reserve_port()
  await reservation.close()
  const stop_tunnel = vi.fn()
  const stop_notice = vi.fn()
  mocks.tunnel.mockResolvedValue(stop_tunnel)
  mocks.notice.mockReturnValue(stop_notice)
  const app = Object.assign(new EventEmitter(), { kill: vi.fn() })
  mocks.spawn.mockReturnValue(app)
  const session = await run_development()
  expect(mocks.notice).toHaveBeenCalledOnce()
  const [executable, args, options] = mocks.spawn.mock.calls[0]!
  expect(executable).toBe(process.execPath)
  expect(args).toEqual(expect.arrayContaining([resolve('node_modules/nuxt/bin/nuxt.mjs'), 'dev', '--port', String(reservation.port)]))
  expect(args[args.indexOf('--host') + 1]).toBe('127.0.0.1')
  expect(options.windowsHide).toBe(true)
  if (event === 'stop')
    session.stop()
  else if (event === 'error')
    app.emit('error', new Error('spawn failed'))
  else
    app.emit('exit', 7)
  expect(await session.completed).toBe(event === 'stop' ? 0 : event === 'error' ? 1 : 7)
  session.stop()
  expect(stop_tunnel).toHaveBeenCalledOnce()
  expect(stop_notice).toHaveBeenCalledOnce()
  expect(app.kill).toHaveBeenCalledOnce()
})

it.each([['--host', '0.0.0.0'], ['--host=0.0.0.0'], ['-h', '0.0.0.0'], ['-h=0.0.0.0'], ['-h0.0.0.0'], ['--public']])('rejects host overrides before starting services: %j', async (... args) => {
  mocks.config.mockReturnValue({ proxy: { targetHost: '127.0.0.1', targetPort: 3042 } })
  await expect(run_development(args)).rejects.toThrow('do not override the listening host')
  expect(mocks.spawn).not.toHaveBeenCalled()
  expect(mocks.tunnel).not.toHaveBeenCalled()
})

it('does not launch the app if tunnel setup fails', async () => {
  const reservation = await reserve_port()
  await reservation.close()
  mocks.tunnel.mockRejectedValue(new Error('invalid tunnel configuration'))
  await expect(run_development()).rejects.toThrow('invalid tunnel configuration')
  expect(mocks.spawn).not.toHaveBeenCalled()
  expect(mocks.notice).not.toHaveBeenCalled()
})
