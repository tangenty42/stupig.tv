import { afterEach, describe, expect, it, vi } from 'vitest'

const boundary = vi.hoisted(() => ({ runtime_config: vi.fn(), load_config: vi.fn(), createConnection: vi.fn(), writeFile: vi.fn() }))
vi.mock('node:fs/promises', () => ({ mkdir: vi.fn(), readFile: vi.fn(), writeFile: boundary.writeFile }))
vi.mock('@config/loader', () => boundary)
vi.mock('mysql2/promise', () => ({ default: { createConnection: boundary.createConnection } }))
vi.mock('@server/lib/storage', () => ({ abort_multipart_upload: vi.fn(), delete_object: vi.fn() }))
vi.mock('@server/lib/aliyun-oss', () => ({ create_aliyun_oss: vi.fn() }))
const { assert_development_reset, assert_reset_object, configured_reset_buckets, inventory_aliyun_content, reset_attachment_objects, reset_image_attempt_objects, reset_development_content } = await import('./reset-dev')

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe('development Content reset boundary', () => {
  it('includes originals from attempt ownership even when no attachment was published', () => {
    const job_id = 'a'.repeat(32)
    const id = 'b'.repeat(32)
    expect(reset_image_attempt_objects({ id, job_id, avif_key: 'content/att/a.avif', jpeg_key: 'content/att/a.jpg' })).toContainEqual({ key: `content/att/originals/${job_id}/${id}`, location: 'aliyun' })
    expect(() => reset_image_attempt_objects({ id: '../escape', job_id, avif_key: '', jpeg_key: '' })).toThrow()
  })

  it('includes every owned image role without treating provenance as an owned file', () => {
    expect(reset_attachment_objects({ storage_provider: 'aliyun', object_key: 'content/a.avif', avif_key: 'content/a.avif', jpeg_key: 'content/a.jpg', original_key: 'content/raw.png' })).toEqual([
      { key: 'content/a.avif', location: 'aliyun' }, { key: 'content/raw.png', location: 'aliyun' }, { key: 'content/a.jpg', location: 'aliyun' },
    ])
  })

  it('inventories only Content objects and refuses an incomplete or escaped SDK listing', async () => {
    const client = {
      listV2: vi.fn().mockResolvedValue({ objects: [], isTruncated: false }),
      listUploads: vi.fn().mockResolvedValue({ uploads: [], isTruncated: false }),
    }
    client.listV2.mockResolvedValueOnce({ objects: [{ name: 'content/orphan' }], isTruncated: true, nextContinuationToken: 'next' })
    client.listUploads.mockResolvedValueOnce({ uploads: [{ name: 'content/staging', uploadId: 'upload' }], isTruncated: false })
    expect(await inventory_aliyun_content(client as unknown as Parameters<typeof inventory_aliyun_content>[0])).toEqual([
      { key: 'content/orphan', location: 'aliyun' }, { key: 'content/staging', location: 'aliyun', upload_id: 'upload' },
    ])
    expect(client.listV2.mock.calls[1]![0]['continuation-token']).toBe('next')
    expect(client.listUploads.mock.calls[0]![0]).toEqual({ 'prefix': 'content/', 'max-uploads': 1000 })
    client.listV2.mockResolvedValueOnce({ objects: [{ name: 'avatar/person' }], isTruncated: false })
    await expect(inventory_aliyun_content(client as unknown as Parameters<typeof inventory_aliyun_content>[0])).rejects.toThrow('Refuse non-Content objects')
    client.listV2.mockResolvedValueOnce({ objects: [{ name: 'content-upload/other-prefix' }], isTruncated: false })
    await expect(inventory_aliyun_content(client as unknown as Parameters<typeof inventory_aliyun_content>[0])).rejects.toThrow('Object escaped')
    client.listV2.mockResolvedValueOnce({ objects: [], isTruncated: true })
    await expect(inventory_aliyun_content(client as unknown as Parameters<typeof inventory_aliyun_content>[0])).rejects.toThrow('Incomplete Content object inventory')
  })

  it('finishes a read-only inventory without a legacy private bucket and refuses tracked private objects', async () => {
    vi.stubEnv('NODE_ENV', 'development')
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const config = (suffix: string) => ({ db: { name: 'stupig_dev', host: 'localhost' }, aliyun: { oss: { bucket: `aliyun-${suffix}` } }, oss: { buckets: { public: { bucket: `public-${suffix}` }, private: null } } })
    boundary.runtime_config.mockReturnValue(config('dev'))
    boundary.load_config.mockReturnValue(config('prod'))
    const connection = { execute: vi.fn().mockResolvedValue([[]]), end: vi.fn(), beginTransaction: vi.fn() }
    boundary.createConnection.mockResolvedValue(connection)
    await expect(reset_development_content(false)).resolves.toBeUndefined()
    expect(connection.end).toHaveBeenCalledTimes(1)
    expect(connection.beginTransaction).not.toHaveBeenCalled()
    expect(boundary.writeFile).not.toHaveBeenCalled()
    connection.execute.mockImplementation(async (sql: string) => [sql.includes('SELECT object_key') ? [{ object_key: 'content/att/private', storage_provider: 'legacy', storage_bucket: 'private' }] : []])
    await expect(reset_development_content(true)).rejects.toThrow('Tracked objects require the legacy private bucket')
    expect(connection.end).toHaveBeenCalledTimes(2)
    expect(connection.beginTransaction).not.toHaveBeenCalled()
    boundary.load_config.mockReturnValue(config('dev'))
    await expect(reset_development_content(true)).rejects.toThrow('Development and production buckets must be distinct')
    expect(boundary.createConnection).toHaveBeenCalledTimes(2)
  })

  it('checks all configured buckets while allowing the retired private bucket to be absent', () => {
    const config = { aliyun: { oss: { bucket: 'aliyun-dev' } }, oss: { buckets: { public: { bucket: 'public-dev' }, private: null } } }
    expect(configured_reset_buckets(config)).toEqual(['aliyun-dev', 'public-dev'])
    const legacy = { ... config, oss: { buckets: { ... config.oss.buckets, private: { bucket: 'private-prod' } } } }
    expect(configured_reset_buckets(legacy)).toEqual(['aliyun-dev', 'public-dev', 'private-prod'])
    expect(() => assert_development_reset('development', 'stupig_dev', configured_reset_buckets(legacy), ['private-prod'], 'localhost')).toThrow()
    expect(() => configured_reset_buckets({ ... config, aliyun: { oss: null } })).toThrow('Aliyun OSS must be configured')
    expect(() => assert_development_reset('development', 'stupig_dev', [], ['prod'], 'localhost')).toThrow()
  })

  it('accepts only development databases and distinct development buckets', () => {
    expect(() => assert_development_reset('development', 'stupig_dev', ['stupig-dev'], ['stupig'], '127.0.0.1')).not.toThrow()
    expect(() => assert_development_reset('development', 'stupig_tv', ['stupig-dev'], ['stupig'], '127.0.0.1')).not.toThrow()
    expect(() => assert_development_reset('production', 'stupig_dev', ['stupig-dev'], ['stupig'], '127.0.0.1')).toThrow()
    expect(() => assert_development_reset('development', 'stupig', ['stupig-dev'], ['stupig'], '127.0.0.1')).toThrow()
    expect(() => assert_development_reset('development', 'stupig_dev', ['stupig-dev'], ['stupig-dev'], '127.0.0.1')).toThrow()
    expect(() => assert_development_reset('development', 'stupig_tv', ['stupig-dev'], ['stupig'], 'production.mysql')).toThrow()
  })
  it('refuses static assets and unrecognized storage locations', () => {
    expect(() => assert_reset_object({ key: 'content/att/a', location: 'aliyun' })).not.toThrow()
    expect(() => assert_reset_object({ key: 'logo.svg', location: 'aliyun' })).toThrow()
    expect(() => assert_reset_object({ key: 'avatar/a', location: 'public' })).toThrow()
    expect(() => assert_reset_object({ key: 'content/../logo.svg', location: 'aliyun' })).toThrow()
  })
})
