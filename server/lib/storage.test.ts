import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  send: vi.fn(),
}))

vi.mock('@aws-sdk/client-s3', () => ({
  AbortMultipartUploadCommand: vi.fn(),
  CopyObjectCommand: vi.fn(),
  DeleteObjectCommand: vi.fn(),
  GetObjectCommand: vi.fn(),
  HeadObjectCommand: vi.fn(),
  ListMultipartUploadsCommand: vi.fn(),
  ListObjectsV2Command: vi.fn(),
  PutObjectCommand: vi.fn(),
  S3Client: class MockS3Client {
    send(... args: unknown[]) {
      return mocks.send(... args)
    }
  },
}))
vi.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl: vi.fn() }))
vi.mock('@config/loader', () => ({
  runtime_config: () => ({
    oss: {
      endpoint: 'https://oss.example.test',
      region: 'test-region',
      forcePathStyle: true,
      accessKeyId: 'test-key',
      accessKeySecret: 'test-secret',
      bucket: 'test-bucket',
    },
  }),
}))

const { delete_object_best_effort } = await import('@server/lib/storage')

describe('delete_object_best_effort', () => {
  beforeEach(() => {
    mocks.send.mockReset()
    vi.restoreAllMocks()
  })

  it('deletes the object when storage is healthy', async () => {
    mocks.send.mockResolvedValue({})
    const error_spy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await delete_object_best_effort('attachment/a.png')

    expect(mocks.send).toHaveBeenCalledOnce()
    expect(error_spy).not.toHaveBeenCalled()
  })

  // A failed delete leaves an orphan object: the caller must not be blocked,
  // but the failure has to be logged so reconciliation can find it.
  it('logs the failure with the key instead of throwing', async () => {
    const failure = new Error('oss unavailable')
    mocks.send.mockRejectedValue(failure)
    const error_spy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect(delete_object_best_effort('attachment/a.png')).resolves.toBeUndefined()
    const line = JSON.parse(error_spy.mock.calls[0]![0] as string)
    expect(line).toMatchObject({
      level: 'error',
      msg: 'storage-delete-failed',
      key: 'attachment/a.png',
      error_class: 'Error',
      error_message: 'oss unavailable',
    })
  })
})
