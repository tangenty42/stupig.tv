import { expect, it, vi } from 'vitest'
import { verify_private_oss_object } from './oss-object-identity'

const identity = { size: 3, etag: 'multipart-etag-2', version_id: 'version' }
function fixture(head = identity, access = 'private') {
  return { head_object: vi.fn().mockResolvedValue(head), get_object_access: vi.fn().mockResolvedValue(access) }
}

it('accepts a private versioned object using metadata without interpreting its ETag as a hash', async () => {
  const storage = fixture()
  await expect(verify_private_oss_object(storage, 'owned-key', identity, 'changed')).resolves.toEqual(identity)
  expect(storage.head_object).toHaveBeenCalledExactlyOnceWith('owned-key')
  expect(storage.get_object_access).toHaveBeenCalledExactlyOnceWith('owned-key')
})

it.each([
  { size: 4 }, { etag: 'changed' }, { version_id: 'changed' }, { version_id: '' }, { etag: '' },
  { size: - 1 }, { size: Number.NaN }, { size: Number.MAX_SAFE_INTEGER + 1 },
])('rejects invalid or changed object metadata: %j', async (change) => {
  await expect(verify_private_oss_object(fixture({ ... identity, ... change }), 'owned-key', identity, 'changed'))
    .rejects.toMatchObject({ statusCode: 409, message: 'changed' })
})

it.each(['public-read', 'public-read-write', 'default'])('rejects %s access even with a matching object identity', async (access) => {
  await expect(verify_private_oss_object(fixture(identity, access), 'owned-key', identity, 'changed'))
    .rejects.toMatchObject({ statusCode: 409 })
})

it('allows an empty ordinary object while requiring its exact size and version', async () => {
  const empty = { ... identity, size: 0 }
  await expect(verify_private_oss_object(fixture(empty), 'owned-key', empty, 'changed')).resolves.toEqual(empty)
})

it('propagates unavailable storage rather than adopting an unchecked object', async () => {
  const storage = fixture()
  const error = Object.assign(new Error('unavailable'), { status: 503 })
  storage.head_object.mockRejectedValue(error)
  await expect(verify_private_oss_object(storage, 'owned-key', identity, 'changed')).rejects.toBe(error)
})
