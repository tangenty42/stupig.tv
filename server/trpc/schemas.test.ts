import { upload_batch_schema } from '@shared/content-upload'
import { workspace_command_schema } from '@shared/content-workspace'
import { describe, expect, it } from 'vitest'
import { api_schema } from './schemas'

const request = { request_id: '00000000-0000-4000-8000-000000000001', scope_id: 1 }
const entry = { path: 'new photo.PNG', size: 10, sha256: 'a'.repeat(64) }
describe('workspace request boundaries', () => {
  it('preserves raw names and duplicate paths for transactional resolve', () => {
    const result = upload_batch_schema.parse({ ... request, entries: [entry, entry] })
    expect(result.entries.map(item => item.path)).toEqual(['new photo.PNG', 'new photo.PNG'])
    expect(Object.values(result.on_error).every(value => value === 'fail')).toBe(true)
  })
  it('requires a source version for replacement and rejects per-item resolution', () => {
    expect(upload_batch_schema.safeParse({ ... request, entries: [{ ... entry, purpose: 'replace' }] }).success).toBe(false)
    expect(upload_batch_schema.safeParse({ ... request, entries: [{ ... entry, on_error: 'skip' }] }).success).toBe(false)
    expect(upload_batch_schema.safeParse({ ... request, entries: [{ ... entry, purpose: 'replace', source: { id: 1, version: 'v1' } }] }).success).toBe(true)
  })
  it('addresses existing nodes by identity and retains invalid new names for resolve', () => {
    const result = workspace_command_schema.parse({ ... request, operation: 'rename', target: { id: 1, version: 'v1' }, name: 'new?name' })
    expect(result).toMatchObject({ name: 'new?name', target: { id: 1, version: 'v1' } })
    expect(workspace_command_schema.safeParse({ ... request, operation: 'delete', targets: [{ id: 1 }], draft_references: [] }).success).toBe(false)
  })
  it('does not expose legacy task or path mutation contracts', () => {
    for (const key of ['get_story', 'create_task', 'preflight_task', 'rename_attachment', 'move_folder', 'delete_attachment', 'begin_upload_session'])
      expect(api_schema.content).not.toHaveProperty(key)
  })
})
