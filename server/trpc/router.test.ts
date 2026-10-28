import type { AuthUser } from '@server/types/auth'
import type { H3Event } from 'h3'
import { ApiError } from '@server/errors/ApiError'
import { ReferenceSafetyError } from '@server/errors/ReferenceSafetyError'
import { public_procedure, router } from '@server/trpc/init'
import { workspace_issue } from '@shared/content-workspace'
import { getTRPCErrorShape, TRPCError } from '@trpc/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const auth_mocks = vi.hoisted(() => ({
  require_auth_user: vi.fn(),
  require_admin_user: vi.fn(),
  resolve_operate_target: vi.fn(),
}))

vi.mock('@server/services/auth-guards.service', () => auth_mocks)
const upload_mocks = vi.hoisted(() => ({ begin_upload_session: vi.fn(), operate_upload_session: vi.fn(), sign_upload_session_part: vi.fn(), list_upload_sessions: vi.fn(), adopt_upload_session: vi.fn() }))
vi.mock('@server/services/content/upload-api.service', () => upload_mocks)
const workspace_mocks = vi.hoisted(() => ({ execute_workspace_command: vi.fn(), get_attachment_workspace: vi.fn() }))
vi.mock('@server/services/content/workspace-command.service', () => workspace_mocks)
vi.mock('@server/services/content/attachment-workspace.service', () => workspace_mocks)
const background_mocks = vi.hoisted(() => ({ get_background_status: vi.fn() }))
vi.mock('@server/services/background/status.service', () => background_mocks)
const audit_mocks = vi.hoisted(() => ({ get_storage_audit_findings: vi.fn() }))
vi.mock('@server/services/storage-audit/service', () => audit_mocks)
// Router contracts supply their own deployment fixture, never local credentials.
vi.mock('../../config/lib/environment.mjs', () => ({ load_environment: () => ({ ... process.env }) }))

for (const [key, value] of Object.entries({
  NODE_ENV: 'production',
  NUXT_OTP_DEBUG: 'false',
  NUXT_CAPTCHA_DEBUG: 'false',
  MYSQL_HOST: '127.0.0.1',
  MYSQL_PORT: '3306',
  MYSQL_USER: 'stupig_tv',
  MYSQL_DATABASE: 'stupig_tv',
  MYSQL_PASSWORD: 'placeholder',
  REDIS_HOST: '127.0.0.1',
  REDIS_PORT: '6379',
  MQTT_HOST: '127.0.0.1',
  MQTT_TCP_PORT: '1883',
  MQTT_WEB_URL: 'ws://localhost:8083/mqtt',
  OSS_PUBLIC_ACCESS_KEY_ID: 'public-id',
  OSS_PUBLIC_ACCESS_KEY_SECRET: 'public-secret',
  OSS_PRIVATE_ACCESS_KEY_ID: 'private-id',
  OSS_PRIVATE_ACCESS_KEY_SECRET: 'private-secret',
  ALIYUN_DYPNS_ACCESS_KEY_ID: 'placeholder',
  ALIYUN_DYPNS_ACCESS_KEY_SECRET: 'placeholder',
  ALIYUN_DYPNS_CAPTCHA_APP_KEY: 'placeholder',
  ALIYUN_OSS_ACCESS_KEY_ID: 'placeholder',
  ALIYUN_OSS_ACCESS_KEY_SECRET: 'placeholder',
  JWT_SECRET: 'x'.repeat(40),
})) {
  vi.stubEnv(key, value)
}

const { app_router } = await import('@server/trpc/router')
vi.unstubAllEnvs()

const auth_user: AuthUser = {
  id: 7,
  session_id: 11,
  username: 'tester',
  phone: '13800138000',
  avatar_file: null,
  is_verified: true,
  is_admin: true,
}

function create_event() {
  return {
    context: { identity_token: 'test-device' },
  } as unknown as H3Event
}

describe('tRPC router contracts', () => {
  it('rejects the retired Bilibili metadata endpoint', async () => {
    const caller = app_router.createCaller({ event: create_event() })
    const content = caller.content as unknown as { getBilibiliVideoCards: (input: { hrefs: string[] }) => Promise<unknown> }
    await expect(content.getBilibiliVideoCards({ hrefs: ['https://www.bilibili.com/video/BV1Pvnd6JEVD'] })).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('waits for commit and the current viewer workspace before acknowledging a command, including receipt replay', async () => {
    const caller = app_router.createCaller({ event: create_event() })
    const command = { request_id: crypto.randomUUID(), scope_id: 24, operation: 'rename' as const, target: { id: 3, version: 'v1' }, name: 'next.txt' }
    const report = { succeeded: ['next.txt'], skipped: [], renamed: [] }
    const snapshot = { nodes: [], attachments: [], folders: [], namespace_revision: 2, viewer_key: '7:true' }
    let commit!: (value: typeof report) => void
    let read!: (value: typeof snapshot) => void
    workspace_mocks.execute_workspace_command.mockImplementationOnce(() => new Promise((resolve) => {
      commit = resolve
    }))
      .mockResolvedValue(report)
    workspace_mocks.get_attachment_workspace.mockImplementationOnce(() => new Promise((resolve) => {
      read = resolve
    }))
      .mockResolvedValue({ ... snapshot, namespace_revision: 3 })
    let acknowledged = false
    const pending = caller.content.executeWorkspaceCommand(command).then((result) => {
      acknowledged = true
      return result
    })
    await vi.waitFor(() => expect(workspace_mocks.execute_workspace_command).toHaveBeenCalledOnce())
    expect(workspace_mocks.get_attachment_workspace).not.toHaveBeenCalled()
    commit(report)
    await vi.waitFor(() => expect(workspace_mocks.get_attachment_workspace).toHaveBeenCalledWith(24, auth_user))
    expect(acknowledged).toBe(false)
    read(snapshot)
    expect(await pending).toEqual({ ... report, workspace: snapshot })
    // Replaying the same receipt reads a fresh projection rather than replaying URLs.
    expect(await caller.content.executeWorkspaceCommand(command)).toEqual({ ... report, workspace: { ... snapshot, namespace_revision: 3 } })
    expect(workspace_mocks.execute_workspace_command.mock.calls[1]![0]).toBe(7)
    expect(workspace_mocks.execute_workspace_command.mock.calls[1]![1].request_id).toBe(command.request_id)
  })

  it('does not acknowledge success when the committed workspace cannot be read', async () => {
    const caller = app_router.createCaller({ event: create_event() })
    workspace_mocks.execute_workspace_command.mockResolvedValue({ succeeded: [], skipped: [], renamed: [] })
    workspace_mocks.get_attachment_workspace.mockRejectedValueOnce(new Error('read unavailable'))
    await expect(caller.content.executeWorkspaceCommand({ request_id: crypto.randomUUID(), scope_id: 24, operation: 'create_folder', parent_id: 1, name: 'docs' })).rejects.toThrow('read unavailable')
  })

  it('requires full admin permission for paginated object-key findings', async () => {
    const caller = app_router.createCaller({ event: create_event() })
    auth_mocks.require_auth_user.mockResolvedValue({ ... auth_user, is_admin: false, permissions: [{ field: 'admin_access', level: 'readonly' }] })
    await expect(caller.admin.getStorageAuditFindings({})).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(audit_mocks.get_storage_audit_findings).not.toHaveBeenCalled()
    auth_mocks.require_auth_user.mockResolvedValue(auth_user)
    audit_mocks.get_storage_audit_findings.mockResolvedValue([])
    expect(await caller.admin.getStorageAuditFindings({ after_id: 2, limit: 10 })).toEqual([])
    expect(audit_mocks.get_storage_audit_findings).toHaveBeenCalledWith({ after_id: 2, limit: 10 })
    await expect(caller.admin.getStorageAuditFindings({ limit: 1001 })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })
  it('allows background status only with admin read permission', async () => {
    const caller = app_router.createCaller({ event: create_event() })
    auth_mocks.require_auth_user.mockResolvedValue({ ... auth_user, is_admin: false })
    await expect(caller.admin.getBackgroundStatus()).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(background_mocks.get_background_status).not.toHaveBeenCalled()
    auth_mocks.require_auth_user.mockRejectedValue(new ApiError(401, '未登录'))
    await expect(caller.admin.getBackgroundStatus()).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
    auth_mocks.require_auth_user.mockResolvedValue(auth_user)
    background_mocks.get_background_status.mockResolvedValue({ mode: 'app', process: null, database: {} })
    expect(await caller.admin.getBackgroundStatus()).toEqual({ mode: 'app', process: null, database: {} })
  })
  beforeEach(() => {
    vi.clearAllMocks()
    auth_mocks.require_auth_user.mockResolvedValue(auth_user)
    auth_mocks.require_admin_user.mockResolvedValue(auth_user)
  })
  it('binds upload discovery and publication to the current authenticated actor', async () => {
    const caller = app_router.createCaller({ event: create_event() })
    await caller.content.listUploadSessions({ id: 24 })
    await caller.content.adoptUploadSession({ session_id: 'a'.repeat(32) })
    expect(upload_mocks.list_upload_sessions).toHaveBeenCalledWith(24, 7)
    expect(upload_mocks.adopt_upload_session).toHaveBeenCalledWith('a'.repeat(32), 7)
  })

  it('binds upload operations to the authenticated actor and rejects identity injection', async () => {
    const caller = app_router.createCaller({ event: create_event() })
    const session_id = 'a'.repeat(32)
    upload_mocks.operate_upload_session.mockResolvedValue({ id: session_id })
    await caller.content.resumeUploadSession({ session_id })
    expect(upload_mocks.operate_upload_session).toHaveBeenCalledWith('resume', session_id, 7)
    const forged = { session_id, actor_id: 99 }
    await expect(caller.content.resumeUploadSession(forged)).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    expect(upload_mocks.operate_upload_session).toHaveBeenCalledOnce()
  })
  it('exposes a read-only session query separately from resume mutations', async () => {
    const caller = app_router.createCaller({ event: create_event() })
    const session_id = 'a'.repeat(32)
    await caller.content.getUploadSession({ session_id })
    expect(upload_mocks.operate_upload_session).toHaveBeenCalledWith('get', session_id, 7)
  })

  it('rejects upload grants without content management permission', async () => {
    auth_mocks.require_auth_user.mockResolvedValue({ ... auth_user, is_admin: false, permissions: [] })
    const caller = app_router.createCaller({ event: create_event() })
    await expect(caller.content.signUploadSessionPart({ session_id: 'a'.repeat(32), part: 1, md5: '1B2M2Y8AsgTpgAmY7PhCfg==' })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(upload_mocks.sign_upload_session_part).not.toHaveBeenCalled()
  })

  it('serves public procedures without authentication', async () => {
    const caller = app_router.createCaller({ event: create_event() })

    await expect(caller.system.health()).resolves.toEqual({ online: true })
    expect(auth_mocks.require_auth_user).not.toHaveBeenCalled()
  })

  it('passes the original H3 event through protected procedure context', async () => {
    const event = create_event()
    const caller = app_router.createCaller({ event })

    await expect(caller.system.me()).resolves.toEqual({
      id: auth_user.id,
      username: auth_user.username,
      is_admin: true,
    })
    expect(auth_mocks.require_auth_user).toHaveBeenCalledWith(event)
  })

  it('maps existing API authorization errors to tRPC status codes', async () => {
    auth_mocks.require_auth_user.mockRejectedValue(new ApiError(401, '请先登录'))
    const caller = app_router.createCaller({ event: create_event() })

    await expect(caller.system.me()).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      message: '请先登录',
    })
  })

  it('rejects invalid Zod inputs before invoking a service', async () => {
    const caller = app_router.createCaller({ event: create_event() })

    await expect(caller.content.getStoryBody({ id: 0 })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    })
  })

  it('serializes only validated application error metadata from ApiError', () => {
    const shape = (cause: Error) => getTRPCErrorShape({
      config: app_router._def._config,
      error: new TRPCError({ code: 'BAD_REQUEST', message: 'error', cause }),
      type: 'mutation', path: 'content.updateStory', input: undefined, ctx: { event: create_event() },
    })
    const public_data = { code: 'BATCH_REJECTED' as const, details: { items: [workspace_issue('a.txt', 'name_conflict', 'NAME_CONFLICT', '同名文件已存在')], valid_count: 0 } }
    expect(shape(new ApiError(409, '整批未执行', public_data)).data.applicationError).toEqual(public_data)
    expect(shape(new ApiError(409, '上传会话已过期', { code: 'UPLOAD_SESSION_EXPIRED' })).data.applicationError).toEqual({ code: 'UPLOAD_SESSION_EXPIRED' })
    expect(shape(new ReferenceSafetyError('历史不可用', 'REF_HISTORY_UNAVAILABLE')).data.applicationError).toEqual({ code: 'REF_HISTORY_UNAVAILABLE' })
    // A lookalike internal error cannot smuggle its SQL/metadata through the formatter.
    expect(shape(Object.assign(new Error('internal'), { public_data })).data.applicationError).toBeUndefined()
    const unsafe = Object.assign(new ApiError(400, 'expected'), { public_data: { ... public_data, details: { ... public_data.details, sql: 'private SQL' } } })
    expect(shape(unsafe).data.applicationError).toBeUndefined()
  })

  it.each([
    [400, 'BAD_REQUEST'],
    [401, 'UNAUTHORIZED'],
    [403, 'FORBIDDEN'],
    [404, 'NOT_FOUND'],
    [409, 'CONFLICT'],
    [413, 'PAYLOAD_TOO_LARGE'],
    [415, 'UNSUPPORTED_MEDIA_TYPE'],
    [429, 'TOO_MANY_REQUESTS'],
    [502, 'BAD_GATEWAY'],
  ] as const)('maps ApiError status %i to %s', async (status, code) => {
    const error_router = router({
      fail: public_procedure.query(() => {
        throw new ApiError(status, 'expected error')
      }),
    })

    await expect(error_router.createCaller({ event: create_event() }).fail()).rejects.toMatchObject({
      code,
      message: 'expected error',
    })
  })
})
