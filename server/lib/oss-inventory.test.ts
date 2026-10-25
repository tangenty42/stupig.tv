import { beforeEach, describe, expect, it, vi } from 'vitest'

const boundary = vi.hoisted(() => ({ listV2: vi.fn() }))
vi.mock('ali-oss', () => ({ default: class { listV2 = boundary.listV2 } }))
const { create_oss_inventory } = await import('./oss-inventory')
const config = { bucket: 'qa-dev', endpoint: 'https://oss.example.test', region: 'oss-cn-shenzhen', publicBaseUrl: 'https://assets.test', accessKeyId: 'id', accessKeySecret: 'secret', timeoutMs: 1000, copyPartSizeMb: 64, uploadRoleArn: null }
const object = (name: string) => ({ name, size: 3, lastModified: '2026-01-01T00:00:00Z', url: 'https://do-not-return' })

beforeEach(() => vi.resetAllMocks())

describe('oSS read-only inventory', () => {
  it('lists bounded UTF-8 keys after the checkpoint without returning SDK URLs or owners', async () => {
    boundary.listV2.mockResolvedValue({ objects: [object('avatar/中.png')], isTruncated: true })
    const result = await create_oss_inventory(config).list_page('avatar/a.png', 25)
    expect(boundary.listV2).toHaveBeenCalledWith({ 'start-after': 'avatar/a.png', 'max-keys': 25 }, {})
    expect(result).toEqual({ objects: [{ key: 'avatar/中.png', size: 3, modified_at: new Date('2026-01-01T00:00:00Z') }], truncated: true })
    expect(JSON.stringify(result)).not.toContain('do-not-return')
  })

  it('checks exact existence using a one-object prefix listing', async () => {
    boundary.listV2.mockResolvedValue({ objects: [object('unknown/key-longer')], isTruncated: false })
    expect(await create_oss_inventory(config).find_object('unknown/key')).toBeNull()
    expect(boundary.listV2).toHaveBeenCalledWith({ 'prefix': 'unknown/key', 'max-keys': 1 }, {})
  })

  it.each([
    { objects: [] },
    { objects: [], isTruncated: true },
    { objects: [object('a'), object('a')], isTruncated: false },
    { objects: [object('z'), object('a')], isTruncated: false },
    { objects: [{ ... object('a'), size: - 1 }], isTruncated: false },
  ])('refuses invalid or non-advancing inventory pages', async (page) => {
    boundary.listV2.mockResolvedValue(page)
    await expect(create_oss_inventory(config).list_page('', 2)).rejects.toMatchObject({ statusCode: 502 })
  })

  it('rejects unbounded batch sizes before any network call', async () => {
    await expect(create_oss_inventory(config).list_page('', 1001)).rejects.toMatchObject({ statusCode: 400 })
    expect(boundary.listV2).not.toHaveBeenCalled()
  })
})
