import { beforeEach, expect, it, vi } from 'vitest'

const boundary = vi.hoisted(() => ({ call: vi.fn() }))
vi.mock('@config/loader', () => ({ runtime_config: () => ({ aliyun: { esaPurge: null } }) }))
vi.mock('@alicloud/openapi-client', () => {
  class Model {
    constructor(value: object) { Object.assign(this, value) }
  }
  return { default: class { callApi = boundary.call }, Config: Model, Params: Model, OpenApiRequest: Model }
})
const { create_esa_preload } = await import('./esa-preload')
const config = { accessKeyId: 'id', accessKeySecret: 'secret', siteId: '123', regionId: 'cn-hangzhou' as const, endpoint: 'esa.cn-hangzhou.aliyuncs.com' as const, timeoutMs: 15000 }
const base = 'https://edge.example.test'
const key = 'content/att/image.avif'
const client = () => create_esa_preload(config, 60)
beforeEach(() => vi.clearAllMocks())

it('submits a canonical single-object URL with the configured site and no read signature', async () => {
  boundary.call.mockResolvedValue({ statusCode: 200, body: { TaskId: 'task-1' } })
  expect(await client().submit(base, key)).toBe('task-1')
  expect(boundary.call.mock.calls[0]![0]).toMatchObject({ action: 'PreloadCaches', method: 'POST' })
  expect(boundary.call.mock.calls[0]![1].query).toEqual({ SiteId: '123', Content: JSON.stringify([`${base}/${key}`]) })
  await expect(client().submit(base, 'other/private?auth_key=secret')).rejects.toThrow()
  expect(boundary.call).toHaveBeenCalledOnce()
})

it('reads daily and 30-day quotas and rejects malformed counters rather than assuming unlimited', async () => {
  boundary.call.mockResolvedValue({ statusCode: 200, body: { Quota: '10000', Usage: '20', Quota30Day: '90000', Usage30Day: '30' } })
  expect(await client().quota()).toEqual({ total: 10000, used: 20, total30: 90000, used30: 30 })
  expect(boundary.call.mock.calls[0]![1].query).toEqual({ SiteId: '123', Type: 'preload' })
  boundary.call.mockResolvedValue({ statusCode: 200, body: { Quota: 'bad' } })
  await expect(client().quota()).rejects.toMatchObject({ code: 'invalid_response' })
})

it.each(['edge', 'edge_smart', 'edge_regional', 'edge_regional_smart'])('checks whether %s supports prefetch', async (mode) => {
  boundary.call.mockResolvedValue({ statusCode: 200, body: { CacheArchitectureMode: mode } })
  expect(await client().tiered()).toBe(mode !== 'edge')
})

it('reconciles a lost acknowledgement using the exact object and original UTC request window', async () => {
  boundary.call.mockResolvedValueOnce({ statusCode: 200, body: { TotalCount: 51, Tasks: [{ TaskId: 'wrong', Content: `${base}/other`, Status: 'Complete' }] } })
    .mockResolvedValueOnce({ statusCode: 200, body: { TotalCount: 51, Tasks: [{ TaskId: 'task', Content: `${base}/${key}`, Status: 'Complete' }] } })
  expect(await client().status(base, key, null, new Date('2026-10-24T01:00:00Z'), new Date('2026-10-24T01:01:00Z'))).toEqual({ status: 'Complete', task: 'task' })
  expect(boundary.call.mock.calls[1]![1].query).toMatchObject({ PageNumber: '2', Content: `${base}/${key}`, StartTime: '2026-10-24T00:59:00Z', EndTime: '2026-10-24T01:02:00Z' })
})

it('does not mistake another completed task for our pending task', async () => {
  boundary.call.mockResolvedValue({ statusCode: 200, body: { TotalCount: 1, Tasks: [{ TaskId: 'other', Content: `${base}/${key}`, Status: 'Complete' }] } })
  expect(await client().status(base, key, 'mine', new Date())).toEqual({ status: 'Missing', task: 'mine' })
})

it('finds a known receipt without excluding it through a skewed creation timestamp', async () => {
  boundary.call.mockResolvedValue({ statusCode: 200, body: { TotalCount: 1, Tasks: [{ TaskId: 'mine', Content: `${base}/${key}`, Status: 'Complete', CreateTime: '2026-10-24T01:00:00Z' }] } })
  expect(await client().status(base, key, 'mine', new Date('2026-10-24T01:00:07Z'))).toEqual({ status: 'Complete', task: 'mine' })
  expect(boundary.call.mock.calls[0]![1].query).not.toHaveProperty('StartTime')
  expect(boundary.call.mock.calls[0]![1].query).not.toHaveProperty('EndTime')
})

it('keeps ambiguous lost receipts unresolved instead of choosing another completed task', async () => {
  boundary.call.mockResolvedValueOnce({ statusCode: 200, body: { TotalCount: 51, Tasks: [{ TaskId: 'older', Content: `${base}/${key}`, Status: 'Complete' }] } })
    .mockResolvedValueOnce({ statusCode: 200, body: { TotalCount: 51, Tasks: [{ TaskId: 'newer', Content: `${base}/${key}`, Status: 'Refreshing' }] } })
  await expect(client().status(base, key, null, new Date())).rejects.toMatchObject({ code: 'task_ambiguous' })
})

it.each([['Forbidden', 'permission_denied'], ['QuotaExceeded', 'quota_exhausted'], ['PreloadQueueFull', 'queue_full'], ['ETIMEDOUT', 'request_failed']])('sanitizes %s without persisting signed requests or credentials', async (code, expected) => {
  boundary.call.mockRejectedValue(Object.assign(new Error('signed URL and secret'), { code }))
  await expect(client().submit(base, key)).rejects.toMatchObject({ code: expected, message: expected })
})
