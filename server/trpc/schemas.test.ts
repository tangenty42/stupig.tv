import { upload_batch_schema } from '@shared/content-upload'
import { workspace_command_schema } from '@shared/content-workspace'
import { describe, expect, it } from 'vitest'
import { api_schema, draft_schema } from './schemas'

const request = { request_id: '00000000-0000-4000-8000-000000000001', scope_id: 1 }
const entry = { path: 'new photo.PNG', size: 10 }
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
  it('creates an undated draft using only its retry identity', () => {
    expect(draft_schema.create.parse({ request_id: command.id })).toEqual({ request_id: command.id })
    expect(draft_schema.create.safeParse({}).success).toBe(false)
  })
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

describe('account request boundaries', () => {
  const registration = { username: '蠢猪_1号', phone: '13800138000', password: 'Example!842', confirm_password: 'Example!842', otp: '123456' }
  const message = (username: string) => api_schema.auth.register.safeParse({ ... registration, username }).error?.issues[0]?.message
  it('rejects development phone numbers outside Nuxt dev mode', () => {
    const phone = '10000000000'
    expect(api_schema.auth.login_with_phone.safeParse({ phone, otp: '123456' }).success).toBe(false)
    expect(api_schema.auth.send_otp.safeParse({ phone, purpose: 'login' }).success).toBe(false)
  })
  it.each(['蠢猪', 'stupig-tv', 'user_01', 'ｓｔｕｐｉｇ１２３', '猪！？（笑）', '《蠢猪》。', 'a1', '１２３a',
    '猪\u302A1', 'a\u302B２', '4\u302C２_', '4\u302D２-', '４\u302E２！', '１\u302F２＿', '猪\u{16FF0}1', 'a\u{16FF1}２',
    '猪〇〡1', 'a〢３', '〣〤_', '〥〦-', '〧〨！', '〩\u302F＿'])('accepts the username %s', (username) => {
    expect(message(username)).toBeUndefined()
  })
  it.each(['a b', 'a\u3000b', 'tab\tname', 'a@b', 'a.b', '🐷🐷', 'café', 'a/b', '4\u0301２'])('rejects characters outside the username alphabet: %j', (username) => {
    expect(message(username)).toBe('用户名只能包含中英文、数字、横杠、下划线和全角字符')
  })
  it.each(['13800138000', '42', '１２３', '4２'])('rejects the all-digit username %s', (username) => {
    expect(message(username)).toBe('用户名不能是纯数字')
  })
  it.each(['〇〡〢〣〤〥〦〧〨〩', '138〇0138000', '１２〡３', '4〨２〩\u302F'])('rejects equivalent numeric forms in the username %j', (username) => {
    expect(message(username)).toBe('用户名不能是纯数字')
  })
  it.each(['13800138000\u302A', '１２３\u302B', '4\u302C２\u302D', '\u302E1\u302F2', '1\u{16FF0}2', '１\u{16FF1}２'])('does not treat combining marks as meaningful text in the numeric username %j', (username) => {
    expect(message(username)).toBe('用户名不能是纯数字')
  })
  it('carries the submit-time captcha through registration and phone login', () => {
    const captcha = { lot_number: 'lot', captcha_output: 'output', pass_token: 'pass', gen_time: 'time' }
    expect(api_schema.auth.register.parse({ ... registration, ... captcha })).toMatchObject(captcha)
    expect(api_schema.auth.login_with_phone.parse({ phone: '13800138000', otp: '123456', ... captcha })).toMatchObject(captcha)
  })
})
