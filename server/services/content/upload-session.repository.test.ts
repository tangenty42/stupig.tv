import type { Connection } from 'mysql2/promise'
import type { UploadAttempt, UploadRow } from './upload-session.repository'
import { beforeEach, expect, it, vi } from 'vitest'
import { adopt_upload_in_transaction, claim_upload_completion, confirm_upload_parts, get_upload, reserve_upload_part } from './upload-session.repository'

const execute = vi.fn()
const connection = { execute } as unknown as Connection
const session = { id: 'a'.repeat(32), status: 'uploading', expected_size: 262161, execution_epoch: 1, active_attempt_id: 'b'.repeat(32) } as UploadRow
const attempt = { id: 'b'.repeat(32), part_size: 262144, upload_id: 'upload', target_key: 'stage' } as UploadAttempt
beforeEach(() => execute.mockReset())

it('refuses unknown owners and expired sessions', async () => {
  execute.mockResolvedValueOnce([[]]).mockResolvedValueOnce([[{ remaining_seconds: 0 }]])
  await expect(get_upload(connection, session.id, 2)).rejects.toMatchObject({ statusCode: 404 })
  await expect(get_upload(connection, session.id, 1)).rejects.toMatchObject({ statusCode: 409, public_data: { code: 'UPLOAD_SESSION_EXPIRED' } })
})

it('refuses another checksum for an already signed part', async () => {
  execute.mockResolvedValue([[{ byte_length: 262144, content_md5: 'different' }]])
  await expect(reserve_upload_part(connection, session, attempt, 1, '1B2M2Y8AsgTpgAmY7PhCfg==')).rejects.toMatchObject({ statusCode: 409 })
  expect(execute).toHaveBeenCalledOnce()
})

it('refuses out-of-plan and terminal part grants before any SQL', async () => {
  await expect(reserve_upload_part(connection, session, attempt, 3, '1B2M2Y8AsgTpgAmY7PhCfg==')).rejects.toMatchObject({ statusCode: 400 })
  await expect(reserve_upload_part(connection, { ... session, status: 'cancelled' } as UploadRow, attempt, 1, '1B2M2Y8AsgTpgAmY7PhCfg==')).rejects.toMatchObject({ statusCode: 409 })
  expect(execute).not.toHaveBeenCalled()
})

it('refuses a foreign or changed OSS part rather than trusting client checkpoints', async () => {
  execute.mockResolvedValue([[{ part_number: 1, byte_length: 262144, content_md5: '1B2M2Y8AsgTpgAmY7PhCfg==' }]])
  await expect(confirm_upload_parts(connection, session, attempt, [{ part_number: 1, size: 262144, etag: 'wrong' }])).rejects.toMatchObject({ statusCode: 409 })
  expect(execute).toHaveBeenCalledOnce()
})

it('does not steal a live completion lease or complete a cancelled upload', async () => {
  await expect(claim_upload_completion(connection, { ... session, busy: 1 } as UploadRow, 'executor', 60)).rejects.toMatchObject({ statusCode: 409 })
  await expect(claim_upload_completion(connection, { ... session, status: 'cancelled' } as UploadRow, 'executor', 60)).rejects.toMatchObject({ statusCode: 409 })
  expect(execute).not.toHaveBeenCalled()
})

it('does not adopt an unverified or mismatched object', async () => {
  execute.mockResolvedValue([[attempt]])
  await expect(adopt_upload_in_transaction(connection, session, { attachment_id: 1, object_key: 'other', version: 'etag' })).rejects.toMatchObject({ statusCode: 409 })
  expect(execute).toHaveBeenCalledOnce()
})

it('requires the completed linked image receipt before adopting AVIF instead of the uploaded PNG', async () => {
  const image_session = { ... session, actor_id: 7, status: 'verifying', intent: { image: {} }, result: { key: 'png', etag: 'png-etag' } } as UploadRow
  const receipt = { attachment_id: 2, object_key: 'a.avif', version: 'avif-etag' }
  execute.mockResolvedValueOnce([[attempt]]).mockResolvedValueOnce([[]])
  await expect(adopt_upload_in_transaction(connection, image_session, receipt)).rejects.toMatchObject({ statusCode: 409 })
  execute.mockResolvedValueOnce([[attempt]]).mockResolvedValueOnce([[{ attachment_id: 2, result: { avif: { key: 'a.avif', etag: 'avif-etag' } } }]]).mockResolvedValue([{ affectedRows: 1 }])
  await adopt_upload_in_transaction(connection, image_session, receipt)
  expect(execute.mock.calls.at(- 2)![1]).toEqual([JSON.stringify(receipt), session.id])
})
