import { upload_batch_schema } from '@shared/content-upload'
import { workspace_command_schema } from '@shared/content-workspace'
import { describe, expect, it } from 'vitest'
import { api_schema, draft_schema } from './schemas'

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
    expect(workspace_command_schema.safeParse({ ... request, operation: 'delete', targets: [{ id: 1 }] }).success).toBe(false)
  })
  it('accepts delete without draft references and rejects the retired field', () => {
    const input = { ... request, operation: 'delete', targets: [{ id: 1, version: 'v1' }] }
    expect(workspace_command_schema.safeParse(input).success).toBe(true)
    expect(workspace_command_schema.safeParse({ ... input, draft_references: [] }).success).toBe(false)
  })
  it('does not expose legacy task or path mutation contracts', () => {
    for (const key of ['get_story', 'create_task', 'preflight_task', 'rename_attachment', 'move_folder', 'delete_attachment', 'begin_upload_session'])
      expect(api_schema.content).not.toHaveProperty(key)
  })

  it('requires a snapshot-bound token for reference history confirmation', () => {
    const input = { markdown: 'text', base_title_revision: 0 }
    expect(api_schema.content.create_story.safeParse({ ... input, confirm_reference_history: true }).success).toBe(false)
    expect(api_schema.content.create_story.safeParse({ ... input, confirm_reference_history: 'a'.repeat(64) }).success).toBe(true)
    expect(api_schema.content.update_story.safeParse({ ... input, id: 1, base_revision: 1, confirm_reference_history: 'bad' }).success).toBe(false)
  })
})

describe('cloud draft command boundaries', () => {
  const lease = { page_id: 'a'.repeat(32), token: 'b'.repeat(64), epoch: 1 }
  const command = { id: 'c'.repeat(32), lease, seq: 1, kind: 'sync' }
  it('accepts empty or unfinished autosave and a final snapshot with release', () => {
    for (const markdown of ['', '<good>unfinished']) {
      expect(draft_schema.command.safeParse({ ... command, markdown }).success).toBe(true)
      expect(draft_schema.command.safeParse({ ... command, kind: 'release', markdown }).success).toBe(true)
    }
  })
  it('requires a confirmed revision for publish/reset and cannot combine publication with replacement text', () => {
    for (const kind of ['publish', 'reset']) {
      expect(draft_schema.command.safeParse({ ... command, kind }).success).toBe(false)
      expect(draft_schema.command.safeParse({ ... command, kind, expected_revision: 1 }).success).toBe(true)
      expect(draft_schema.command.safeParse({ ... command, kind, expected_revision: 1, markdown: 'replacement' }).success).toBe(false)
    }
  })
  it('rejects malformed lease identities, unsafe counters and ambiguous targets', () => {
    expect(draft_schema.command.safeParse({ ... command, lease: { ... lease, token: 'short' } }).success).toBe(false)
    expect(draft_schema.command.safeParse({ ... command, seq: 0 }).success).toBe(false)
    expect(draft_schema.command.safeParse({ ... command, seq: Number.MAX_SAFE_INTEGER + 1 }).success).toBe(false)
    expect(draft_schema.acquire.safeParse({ id: command.id, expected_epoch: Number.MAX_SAFE_INTEGER, ... lease }).success).toBe(false)
    expect(draft_schema.get.safeParse({ id: command.id, story_id: 1 }).success).toBe(false)
    expect(draft_schema.get.safeParse({}).success).toBe(false)
  })
})
