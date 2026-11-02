import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const boundary = vi.hoisted(() => ({ port: 3306, events: [] as string[], query: vi.fn(), execute: vi.fn(), end: vi.fn(), connect: vi.fn(), request: vi.fn() }))
vi.mock('@config/loader', () => ({
  load_aliyun_oss_config: () => ({ region: 'oss-cn-guangzhou', endpoint: 'https://oss-cn-guangzhou.aliyuncs.com', bucket: 'fixture-bucket', accessKeyId: 'not-logged', accessKeySecret: 'not-logged', timeoutMs: 10000 }),
  load_database_config: () => ({ host: '127.0.0.1', port: boundary.port, user: 'not-logged', password: 'not-logged', name: 'fixture' }),
}))
vi.mock('mysql2/promise', () => ({ default: { createConnection: boundary.connect } }))
vi.mock('ali-oss', () => ({ default: class {
  request = boundary.request
} }))
const { inventory_main, inventory_arguments } = await import('./inventory')
let directory: string
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'oss-inventory-'))
  boundary.events.length = 0
  boundary.port = 3306
  boundary.query.mockReset().mockImplementation(async (sql: string) => {
    boundary.events.push(sql)
    return [[{ name: 'fixture', server_uuid: 'server-identity' }]]
  })
  boundary.end.mockReset().mockResolvedValue(undefined)
  boundary.execute.mockReset()
  boundary.connect.mockReset().mockResolvedValue({ query: boundary.query, execute: boundary.execute, end: boundary.end })
  boundary.request.mockReset().mockImplementation(async () => {
    boundary.events.push('GET')
    return { data: { IsTruncated: 'false', Status: 'Enabled' } }
  })
  vi.spyOn(console, 'log').mockImplementation(() => {})
})
afterEach(async () => {
  vi.restoreAllMocks()
  await rm(directory, { recursive: true, force: true })
})

it('runs the real CLI in a read-only DB session and resumes across a changed tunnel port', async () => {
  const args = ['--output', directory]
  expect(await inventory_main(args)).toBe(0)
  expect(boundary.events.indexOf('SET SESSION TRANSACTION READ ONLY')).toBeLessThan(boundary.events.indexOf('GET'))
  expect(boundary.request.mock.calls.every(([parameters]) => parameters.method === 'GET')).toBe(true)
  const first = JSON.parse(await readFile(join(directory, 'checkpoint.json'), 'utf8'))
  boundary.port = 13347
  expect(await inventory_main(args)).toBe(0)
  const second = JSON.parse(await readFile(join(directory, 'checkpoint.json'), 'utf8'))
  expect(second.target).toBe(first.target)
  expect(second.requests).toBe(first.requests + 2)
  expect(boundary.end).toHaveBeenCalledTimes(2)
  expect(console.log).not.toHaveBeenCalledWith(expect.stringContaining('not-logged'))
})

it('rejects changed scan scope before any new OSS request and releases its lock', async () => {
  expect(await inventory_main(['--output', directory])).toBe(0)
  boundary.request.mockClear()
  await expect(inventory_main(['--output', directory, '--prefix', 'different/'])).rejects.toThrow('inventory_resume_target_or_options_mismatch')
  expect(boundary.request).not.toHaveBeenCalled()
  expect(await inventory_main(['--output', directory])).toBe(0)
})

it('does not take over or remove another run lock', async () => {
  await writeFile(join(directory, 'run.lock'), 'owned elsewhere')
  await expect(inventory_main(['--output', directory])).rejects.toMatchObject({ code: 'EEXIST' })
  expect(boundary.connect).not.toHaveBeenCalled()
  expect(await readFile(join(directory, 'run.lock'), 'utf8')).toBe('owned elsewhere')
})

it('has a no-connection help path and no cleanup/apply flags', async () => {
  expect(await inventory_main(['--help'])).toBe(0)
  expect(boundary.connect).not.toHaveBeenCalled()
  expect(boundary.request).not.toHaveBeenCalled()
  expect(() => inventory_arguments(['--apply'])).toThrow()
  expect(() => inventory_arguments(['--max-requests', '0'])).toThrow('invalid_inventory_arguments')
})

it('can inventory metadata without a DB while explicitly leaving all protection checks unverified', async () => {
  expect(await inventory_main(['--metadata-only', '--output', directory])).toBe(0)
  expect(boundary.connect).not.toHaveBeenCalled()
  const report = JSON.parse(await readFile(join(directory, 'report.json'), 'utf8'))
  expect(report.complete).toBe(true)
  expect(report.protection_checks_complete).toBe(false)
  expect(report.options.catalog_mode).toBe('unverified')
})
