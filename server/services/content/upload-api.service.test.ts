import { beforeEach, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  config: { bucket: 'test', region: 'oss-cn-shenzhen', endpoint: 'https://oss-cn-shenzhen.aliyuncs.com' } as object | null,
  execute: vi.fn(), create: vi.fn(), storage: vi.fn(), publish: vi.fn(), actor: vi.fn(),
  get: vi.fn(), resume: vi.fn(),
  lifecycle: { cancel: vi.fn(), expire: vi.fn(), cleanup: vi.fn() },
  image_cleanup: vi.fn(),
  lifecycle_options: { enabled: true, sweepIntervalSeconds: 5, scanLimit: 20 },
}))
vi.mock('@config/loader', () => ({ runtime_config: () => ({ aliyun: { oss: state.config }, app: { contentImages: { enabled: false }, contentUploads: state.lifecycle_options } }) }))
vi.mock('./upload-lifecycle.service', () => ({ create_upload_lifecycle: () => state.lifecycle }))
vi.mock('./upload-image.service', () => ({ create_upload_images: () => ({ state: async (value: unknown) => value, retry: vi.fn(), jobs: { cleanup: state.image_cleanup } }) }))
vi.mock('@server/lib/db', () => ({ db: { execute: state.execute } }))
vi.mock('@server/lib/aliyun-oss', () => ({ create_aliyun_oss: state.storage }))
vi.mock('@server/lib/sync', () => ({ publish_refresh: state.publish, sync_resource: (type: string, id: string) => `${type}:${id}` }))
vi.mock('./workspace-auth.service', () => ({ require_workspace_actor: state.actor }))
vi.mock('./upload-session.service', () => ({ create_upload_sessions: state.create }))
const { operate_upload_session, sweep_content_uploads } = await import('./upload-api.service')
beforeEach(() => {
  vi.clearAllMocks()
  state.config = { bucket: 'test', region: 'oss-cn-shenzhen', endpoint: 'https://oss-cn-shenzhen.aliyuncs.com' }
  state.execute.mockResolvedValue([[]])
  state.create.mockReturnValue({ get: state.get, resume: state.resume })
  state.get.mockResolvedValue({ id: 'session', status: 'uploading' })
  state.resume.mockResolvedValue({ id: 'session', status: 'uploading' })
  state.lifecycle_options.enabled = true
  state.lifecycle.cleanup.mockResolvedValue('')
  state.image_cleanup.mockResolvedValue({ pending: 0, next_cursor: null })
})

it('leaves notification ownership to the transactional services, including reads and resume', async () => {
  await operate_upload_session('get', 'session', 7)
  expect(state.get).toHaveBeenCalledWith('session', 7)
  expect(state.publish).not.toHaveBeenCalled()
  await operate_upload_session('resume', 'session', 7)
  expect(state.resume).toHaveBeenCalledWith('session', 7)
  expect(state.publish).not.toHaveBeenCalled()
})

it('wires durable cancellation and scans ordinary uploads even when image processing is disabled', async () => {
  await sweep_content_uploads()
  expect(state.lifecycle.expire).toHaveBeenCalledOnce()
  expect(state.lifecycle.cleanup).toHaveBeenCalledExactlyOnceWith('', undefined)
  expect(state.image_cleanup).toHaveBeenCalledExactlyOnceWith('', undefined)
  expect(state.create.mock.calls[0]![0].on_cancel).toBe(state.lifecycle.cancel)
  state.lifecycle_options.enabled = false
  await sweep_content_uploads()
  expect(state.lifecycle.expire).toHaveBeenCalledOnce()
  expect(state.image_cleanup).toHaveBeenCalledOnce()
})

it('rechecks the current actor and private grant inside the scope transaction', async () => {
  await operate_upload_session('get', 'session', 7)
  const connection = { execute: vi.fn().mockResolvedValue([[{ id: 1 }]]) }
  const authorize = state.create.mock.calls[0]![0].authorize
  await authorize(connection, 7, { scope_id: 1, target_access: 'private' })
  expect(state.actor).toHaveBeenCalledWith(7, true, connection)
  connection.execute.mockResolvedValue([[]])
  await expect(authorize(connection, 7, { scope_id: 1, target_access: 'private' })).rejects.toMatchObject({ statusCode: 404 })
})

it('fails closed until destination and upload migrations are available', async () => {
  state.config = null
  await expect(operate_upload_session('get', 'session', 7)).rejects.toMatchObject({ statusCode: 503 })
  state.config = { bucket: 'test' }
  state.execute.mockRejectedValue(Object.assign(new Error('missing'), { code: 'ER_NO_SUCH_TABLE' }))
  await expect(operate_upload_session('get', 'session', 7)).rejects.toMatchObject({ statusCode: 503 })
  expect(state.create).not.toHaveBeenCalled()
})
