import { describe, expect, it } from 'vitest'
import { attachment_name_key, error_policy_schema, resolve_workspace_name, workspace_command_schema } from './content-workspace'
import { settings } from './settings'

it('accepts versioned privacy batches and rejects empty, oversized or obsolete single-target requests', () => {
  const base = { operation: 'set_private', request_id: '00000000-0000-4000-8000-000000000001', scope_id: 1, private: true }
  const targets = [{ id: 2, version: 'v1' }, { id: 3, version: 'v2' }]
  expect(workspace_command_schema.parse({ ... base, targets })).toMatchObject({ targets, private: true })
  expect(workspace_command_schema.safeParse({ ... base, targets: [] }).success).toBe(false)
  expect(workspace_command_schema.safeParse({ ... base, targets: Array.from({ length: settings.app.content.workspace.batchLimit + 1 }).fill(targets[0]) }).success).toBe(false)
  expect(workspace_command_schema.safeParse({ ... base, target: targets[0] }).success).toBe(false)
})

describe('workspace name resolution', () => {
  const defaults = error_policy_schema.parse({})
  it('defaults every category to rejection and never silently renames a collision', () => {
    expect(Object.values(defaults)).toEqual(['fail', 'fail', 'fail', 'fail', 'fail', 'fail'])
    expect(resolve_workspace_name('a.txt', false, defaults, () => 'name_conflict').issue?.code).toBe('NAME_TAKEN')
  })
  it('shares NFC and case folding without folding accents', () => {
    expect(attachment_name_key('E\u0301.TXT')).toBe(attachment_name_key('É.txt'))
    expect(attachment_name_key('é')).not.toBe(attachment_name_key('e'))
  })
  it.each([['file.txt', 'file_3.txt'], ['file_1.txt', 'file_3.txt'], ['a.tar.gz', 'a.tar_1.gz'], ['cards', 'cards_1']])('resolves %s to %s across stored and reserved names', (name, expected) => {
    const occupied = (path: string) => path === name || ['file_1.txt', 'file_2.txt'].includes(path) ? 'reserved' as const : null
    const result = resolve_workspace_name(name, name === 'cards', { ... defaults, reserved: 'suffix' }, occupied)
    expect(result.path).toBe(expected)
    expect(result.issue).toBeNull()
  })
  it('checks collisions again after an explicitly requested sanitize', () => {
    const result = resolve_workspace_name('a?.txt', false, { ... defaults, invalid_name: 'sanitize' }, () => 'name_conflict')
    expect(result.issue?.category).toBe('name_conflict')
    expect(result.renamed[0]?.via).toBe('sanitize')
  })
  it.each([['photos.good', true, 'photos_1.good'], ['secret.PNG.good', false, 'secret_1.PNG.good']])('keeps the ACL marker after numbering %s', (name, folder, expected) => {
    const result = resolve_workspace_name(name, folder, { ... defaults, name_conflict: 'suffix' }, path => path === name ? 'name_conflict' : null)
    expect(result.path).toBe(expected)
    expect(result.issue).toBeNull()
  })
  it.each(['...', 'folder/...', '/'])('rejects a name that sanitizes to an empty segment: %s', (name) => {
    expect(resolve_workspace_name(name, false, { ... defaults, invalid_name: 'sanitize' }, () => null).issue?.category).toBe('invalid_name')
  })
  it.each([['a?.txt', 'a_.txt'], ['???', '___'], ['folder/???', 'folder/___'], ['a b#.txt', 'a_b_.txt']])('replaces illegal characters with underscores: %s', (name, expected) => {
    const result = resolve_workspace_name(name, false, { ... defaults, invalid_name: 'sanitize' }, () => null)
    expect(result.issue).toBeNull()
    expect(result.path).toBe(expected)
    expect(result.renamed).toEqual([{ target: name, from: name, to: expected, via: 'sanitize' }])
  })
  it('checks the replaced name for collisions and numbers it only when explicitly requested', () => {
    const occupied = (path: string) => path === 'a_.txt' ? 'name_conflict' as const : null
    const policy = { ... defaults, invalid_name: 'sanitize' as const }
    expect(resolve_workspace_name('a?.txt', false, policy, occupied).issue?.code).toBe('NAME_TAKEN')
    const result = resolve_workspace_name('a?.txt', false, { ... policy, name_conflict: 'suffix' }, occupied)
    expect(result.path).toBe('a__1.txt')
    expect(result.issue).toBeNull()
    expect(result.renamed.map(item => item.via)).toEqual(['sanitize', 'suffix'])
  })
})
