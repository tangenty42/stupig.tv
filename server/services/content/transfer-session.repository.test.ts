import type { Connection } from 'mysql2/promise'
import { beforeEach, expect, it, vi } from 'vitest'
import { accept_transfer, cancel_transfer, claim_transfer, complete_transfer_in_transaction, heartbeat_transfer, record_transfer_part, verify_transfer_attempt } from './transfer-session.repository'

const execute = vi.fn()
const connection = { execute } as unknown as Connection
const claim = { id: 'a'.repeat(32), executor_id: 'b'.repeat(32), epoch: 1 }
const attempt = 'c'.repeat(32)
const intent = {
  scope_id: 1, operation: 'copy' as const, target_path: 'copy.bin', target_location: 'aliyun' as const,
  target_access: 'private' as const, expected_size: 262_161,
  source: { attachment_id: 1, revision: '1', location: 'legacy_private' as const, key: 'source', etag: 'fixed', oss_version_id: null, sha256: null },
}
beforeEach(() => execute.mockReset())

it('rejects invalid source intents and request identities before any SQL', async () => {
  await expect(accept_transfer(connection, 1, 'bad-request', intent, 60)).rejects.toThrow()
  await expect(accept_transfer(connection, 1, crypto.randomUUID(), { ... intent, source: null } as unknown as typeof intent, 60)).rejects.toThrow()
  expect(execute).not.toHaveBeenCalled()
})

it.each(['fingerprint', 'expiry'])('rejects conflicting or expired durable receipts: %s', async (guard) => {
  let actual_fingerprint = ''
  execute.mockImplementationOnce(async (_sql, values) => {
    actual_fingerprint = values[3]
    throw Object.assign(new Error('Duplicate'), { code: 'ER_DUP_ENTRY' })
  }).mockImplementationOnce(async () => [[{ fingerprint: guard === 'expiry' ? actual_fingerprint : 'different', expired: guard === 'expiry' ? 1 : 0 }]])
  await expect(accept_transfer(connection, 1, crypto.randomUUID(), intent, 60)).rejects.toThrow(guard === 'expiry' ? '请求已过期' : '不同的传输内容')
})

it('does not adopt another request that reserved the same target', async () => {
  execute.mockRejectedValueOnce({ code: 'ER_DUP_ENTRY' }).mockResolvedValueOnce([[]])
  await expect(accept_transfer(connection, 1, crypto.randomUUID(), intent, 60)).rejects.toMatchObject({ statusCode: 409 })
})

it('does not grant a competing claim or heartbeat after its conditional update loses', async () => {
  execute.mockResolvedValue([{ affectedRows: 0 }])
  expect(await claim_transfer(connection, claim.id, claim.executor_id, 30, 5)).toBeNull()
  await expect(heartbeat_transfer(connection, claim, 30)).rejects.toMatchObject({ statusCode: 409 })
})

it('refuses late checkpoint writes after the fenced session lookup fails', async () => {
  execute.mockResolvedValueOnce([[]])
  await expect(record_transfer_part(connection, claim, attempt, { number: 1, size: 262_144, etag: 'part' })).rejects.toMatchObject({ statusCode: 409 })
  expect(execute).toHaveBeenCalledOnce()
})

it('refuses wrong-sized and conflicting confirmed parts', async () => {
  const fixture = () => execute.mockResolvedValueOnce([[{ active_attempt_id: attempt, expected_size: 262_161 }]])
    .mockResolvedValueOnce([[{ upload_id: 'upload', status: 'uploading', part_size: 262_144 }]])
  fixture()
  await expect(record_transfer_part(connection, claim, attempt, { number: 1, size: 17, etag: 'part' })).rejects.toMatchObject({ statusCode: 409 })
  expect(execute).toHaveBeenCalledTimes(2)
  fixture().mockResolvedValueOnce([[{ etag: 'old', byte_length: 262_144, range_start: 0 }]])
  await expect(record_transfer_part(connection, claim, attempt, { number: 1, size: 262_144, etag: 'changed' })).rejects.toMatchObject({ statusCode: 409 })
  expect(execute).toHaveBeenCalledTimes(5)
})

it('does not verify an assembled object when durable part coverage is incomplete', async () => {
  execute.mockResolvedValueOnce([[{ active_attempt_id: attempt, expected_size: 262_161, intent }]])
    .mockResolvedValueOnce([[{ upload_id: 'upload', status: 'uploading', part_size: 262_144 }]])
    .mockResolvedValueOnce([[{ count: 1, bytes: 262_144 }]])
  await expect(verify_transfer_attempt(connection, claim, attempt, { size: 262_161, etag: 'object', oss_version_id: 'version', sha256: 'a'.repeat(64) })).rejects.toMatchObject({ statusCode: 409 })
  expect(execute).toHaveBeenCalledTimes(3)
})

it.each([{ object_key: 'other-key', version: 'verified-version' }, { object_key: 'verified-key', version: 'wrong-version' }])('requires the verified target identity for terminal completion: %j', async (result) => {
  execute.mockResolvedValueOnce([[{ active_attempt_id: attempt }]])
    .mockResolvedValueOnce([[{ status: 'verified', target_key: 'verified-key', object_etag: 'verified-version' }]])
  await expect(complete_transfer_in_transaction(connection, claim, attempt, { attachment_id: 1, ... result })).rejects.toMatchObject({ statusCode: 409 })
  expect(execute).toHaveBeenCalledTimes(2)
})

it('does not verify bytes that differ from the fixed source digest', async () => {
  execute.mockResolvedValueOnce([[{ active_attempt_id: attempt, expected_size: 262_161, intent: { ... intent, source: { ... intent.source, sha256: 'b'.repeat(64) } } }]])
    .mockResolvedValueOnce([[{ upload_id: null, status: 'created' }]])
  await expect(verify_transfer_attempt(connection, claim, attempt, { size: 262_161, etag: 'object', oss_version_id: 'version', sha256: 'a'.repeat(64) })).rejects.toMatchObject({ statusCode: 409 })
  expect(execute).toHaveBeenCalledTimes(2)
})

it('returns the original completed result on cancellation without deleting the adopted object', async () => {
  const result = { status: 'completed', result: { attachment_id: 42 } }
  execute.mockResolvedValueOnce([[result]])
  expect(await cancel_transfer(connection, claim.id, 1)).toEqual(result)
  expect(execute).toHaveBeenCalledOnce()
})
