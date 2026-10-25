import { beforeEach, expect, it, vi } from 'vitest'

const boundary = vi.hoisted(() => ({ call: vi.fn() }))
vi.mock('@config/loader', () => ({ runtime_config: () => ({ aliyun: { esaPurge: null } }) }))
vi.mock('@alicloud/openapi-client', () => {
  class Model {
    constructor(value: object) {
      Object.assign(this, value)
    }
  }
  return { default: class { callApi = boundary.call }, Config: Model, Params: Model, OpenApiRequest: Model }
})
const { create_esa_purge, retirement_url } = await import('./esa-purge')
const config = { accessKeyId: 'id', accessKeySecret: 'secret', siteId: '123', regionId: 'cn-hangzhou' as const, endpoint: 'esa.cn-hangzhou.aliyuncs.com' as const, timeoutMs: 15000 }
const base = 'https://dev.example.test'
const key = 'content/att/中文 #%.avif'
beforeEach(() => vi.clearAllMocks())

it('uses a single canonical unsigned file URL and the configured site', async () => {
  boundary.call.mockResolvedValue({ statusCode: 200, body: { TaskId: 'task-1' } })
  expect(await create_esa_purge(config).submit(base, key)).toBe('task-1')
  const [params, request] = boundary.call.mock.calls[0]!
  expect(params).toMatchObject({ action: 'PurgeCaches', method: 'POST', version: '2024-09-10' })
  expect(request.query).toEqual({ SiteId: '123', Type: 'file', Content: JSON.stringify({ Files: [`${base}/content/att/%E4%B8%AD%E6%96%87%20%23%25.avif`] }) })
})

it('rejects missing credentials, non-Content paths and non-origin ESA addresses before requesting', () => {
  expect(() => create_esa_purge()).toThrow('尚未配置')
  for (const invalid of ['other/a', 'content/att/../a', 'content/att//a', 'content/att/a?auth_key=secret', 'content/att/a\\b'])
    expect(() => retirement_url(base, invalid)).toThrow('地址无效')
  for (const invalid of ['http://dev.example.test', `${base}/path`, `${base}?auth_key=x`, 'https://user:pass@dev.example.test'])
    expect(() => retirement_url(invalid, key)).toThrow('地址无效')
  expect(boundary.call).not.toHaveBeenCalled()
})

it('checks exact task, URL and type across pages, rather than another completed task', async () => {
  const url = retirement_url(base, key)
  boundary.call.mockResolvedValueOnce({ statusCode: 200, body: { TotalCount: 51, Tasks: [{ TaskId: 'other', Content: url, Type: 'file', Status: 'Complete' }] } })
    .mockResolvedValueOnce({ statusCode: 200, body: { TotalCount: 51, Tasks: [{ TaskId: 'task', Content: url, Type: 'file', Status: 'Refreshing' }] } })
  expect(await create_esa_purge(config).status(base, key, 'task')).toBe('Refreshing')
  expect(boundary.call.mock.calls[1]![1].query).toMatchObject({ Content: url, PageNumber: '2', SiteId: '123' })
})

it.each(['Complete', 'Refreshing', 'Failed'])('returns confirmed task status %s', async (status) => {
  boundary.call.mockResolvedValue({ statusCode: 200, body: { TotalCount: 1, Tasks: [{ TaskId: 'task', Content: retirement_url(base, key), Type: 'file', Status: status }] } })
  expect(await create_esa_purge(config).status(base, key, 'task')).toBe(status)
})

it('keeps missing history distinct from success and sanitizes external failures', async () => {
  boundary.call.mockResolvedValue({ statusCode: 200, body: { TotalCount: 0, Tasks: [] } })
  expect(await create_esa_purge(config).status(base, key, 'old')).toBe('Missing')
  boundary.call.mockRejectedValue(new Error('secret signed-request'))
  await expect(create_esa_purge(config).submit(base, key)).rejects.toMatchObject({ message: 'ESA 缓存刷新请求失败' })
})

it('does not accept a successful HTTP response without a valid receipt', async () => {
  boundary.call.mockResolvedValue({ statusCode: 200, body: {} })
  await expect(create_esa_purge(config).submit(base, key)).rejects.toThrow('有效刷新任务')
  await expect(create_esa_purge(config).status(base, key, 'task')).rejects.toThrow('响应无效')
})
