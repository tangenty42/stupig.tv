import type { AppRouter } from '@server/trpc/router'
import type { PermissionGrant } from '@shared/permissions'
import type { ContentStoryBody } from '@shared/types/content'
import type { inferRouterInputs } from '@trpc/server'
import { settings } from '@shared/settings'

type RouterInputs = inferRouterInputs<AppRouter>
type AuthInputs = RouterInputs['auth']
type ProfileInputs = RouterInputs['profile']

export function get_error_status(error: unknown) {
  const value = error as {
    statusCode?: number
    status?: number
    data?: { httpStatus?: number }
  }
  return value?.data?.httpStatus ?? value?.statusCode ?? value?.status
}

/**
 * Whether the request itself was rejected — a 4xx the caller's input caused
 * (broken markdown, a name taken meanwhile, a folder that is not empty) rather
 * than a failure on our side. 401 is excluded: the session layer ends the
 * session for it, so a toast would only repeat that.
 */
export function is_client_error(error: unknown) {
  const status = get_error_status(error)
  return typeof status === 'number' && status >= 400 && status < 500 && status !== 401
}

export function useApi() {
  const { call: trpc_call, client: trpc, upload: trpc_upload } = useTrpcClient()

  async function get_story_body(id: number): Promise<ContentStoryBody>
  async function get_story_body(id: number, base_representation_version: string): Promise<ContentStoryBody | null>
  async function get_story_body(id: number, base_representation_version?: string): Promise<ContentStoryBody | null> {
    return trpc_call(trpc.content.getStoryBody.query({ id, base_representation_version }))
  }

  const auth = {
    async send_otp(payload: AuthInputs['sendOtp']) {
      await trpc_call(trpc.auth.sendOtp.mutate(payload))
    },

    async get_otp_cooldown(payload?: AuthInputs['getOtpCooldown']) {
      return trpc_call(trpc.auth.getOtpCooldown.query(payload))
    },

    async login_with_password(payload: AuthInputs['loginWithPassword']) {
      return trpc_call(trpc.auth.loginWithPassword.mutate(payload))
    },

    async login_with_phone(payload: AuthInputs['loginWithPhone']) {
      return trpc_call(trpc.auth.loginWithPhone.mutate(payload))
    },

    async register(payload: AuthInputs['register']) {
      return trpc_call(trpc.auth.register.mutate(payload))
    },
  }

  const profile = {
    async get_me() {
      return trpc_call(trpc.profile.getMe.query())
    },

    async get_profile(id: number) {
      return trpc_call(trpc.profile.get.query({ id }))
    },

    async get_my_sessions() {
      return trpc_call(trpc.profile.getSessions.query())
    },

    async force_logout_session(id: number) {
      await trpc_call(trpc.profile.forceLogoutSession.mutate({ id }))
    },

    async get_user_sessions(user_id: number) {
      return trpc_call(trpc.profile.getSessions.query({ operate_for: user_id }))
    },

    async force_logout_user_session(user_id: number, session_id: number) {
      await trpc_call(trpc.profile.forceLogoutSession.mutate({
        id: session_id,
        operate_for: user_id,
      }))
    },

    async reset_password_for(user_id: number, payload: { new_password: string, confirm_new_password: string }) {
      await trpc_call(trpc.profile.resetPasswordFor.mutate({ ... payload, operate_for: user_id }))
    },

    async change_phone_for(user_id: number, new_phone: string) {
      await trpc_call(trpc.profile.changePhoneFor.mutate({ new_phone, operate_for: user_id }))
    },

    async update_birthday(birthday: string | null, operate_for?: number | null) {
      await trpc_call(trpc.profile.updateBirthday.mutate({ birthday, operate_for: operate_for ?? null }))
    },

    async change_password(payload: ProfileInputs['changePassword']) {
      await trpc_call(trpc.profile.changePassword.mutate(payload))
    },

    async change_password_by_otp(payload: ProfileInputs['changePasswordByOtp']) {
      await trpc_call(trpc.profile.changePasswordByOtp.mutate(payload))
    },

    async change_phone(payload: ProfileInputs['changePhone']) {
      await trpc_call(trpc.profile.changePhone.mutate(payload))
    },

    async upload_avatar(file: File, operate_for?: number | null) {
      const form = new FormData()
      form.append('avatar', file)

      if (operate_for) {
        form.append('operate_for', String(operate_for))
      }

      await trpc_upload('profile.uploadAvatar', form)
    },

    async delete_avatar(operate_for?: number | null) {
      await trpc_call(trpc.profile.deleteAvatar.mutate(operate_for ? { operate_for } : undefined))
    },
  }

  const admin = {
    async get_background_status() {
      return trpc_call(trpc.admin.getBackgroundStatus.query())
    },
    async get_storage_audit_findings(after_id = 0, limit = 50) {
      return trpc_call(trpc.admin.getStorageAuditFindings.query({ after_id, limit }))
    },
    async list_users(options: {
      page: number
      page_size: number
      filter?: string
    }) {
      return trpc_call(trpc.admin.listUsers.query(options))
    },

    async set_banned(id: number, banned: boolean) {
      await trpc_call(trpc.admin.setBanned.mutate({ id, banned }))
    },

    async force_logout(id: number) {
      await trpc_call(trpc.admin.forceLogout.mutate({ id }))
    },

    async set_verification(id: number, is_verified: boolean, note?: string | null) {
      await trpc_call(trpc.admin.setVerification.mutate({ id, is_verified, verified_note: note }))
    },

    async set_admin_role(id: number, is_admin: boolean) {
      await trpc_call(trpc.admin.setRole.mutate({ id, is_admin }))
    },

    async set_permissions(id: number, permissions: PermissionGrant[]) {
      await trpc_call(trpc.admin.setPermissions.mutate({ id, permissions }))
    },

    async get_keywords() {
      const result = await trpc_call(trpc.admin.getKeywords.query())
      return { ... result, fields: [... result.fields] }
    },
  }

  async function draft_call<T>(request: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        trpc_call(request(controller.signal)),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            controller.abort()
            reject(new Error('连接超时，已暂停编辑'))
          }, settings.app.content.draft.requestTimeoutMs)
        }),
      ])
    }
    finally { clearTimeout(timer) }
  }

  const content = {
    create_draft: (request_id: string) => draft_call(signal => trpc.content.createDraft.mutate({ request_id }, { signal })),
    get_draft: (input: RouterInputs['content']['getDraft']) => draft_call(signal => trpc.content.getDraft.mutate(input, { signal })),
    list_drafts: (after = '', limit = 30) => draft_call(signal => trpc.content.listDrafts.query({ after, limit }, { signal })),
    acquire_draft: (input: RouterInputs['content']['acquireDraft']) => draft_call(signal => trpc.content.acquireDraft.mutate(input, { signal })),
    command_draft: (input: RouterInputs['content']['commandDraft']) => draft_call(signal => trpc.content.commandDraft.mutate(input, { signal })),
    async execute_workspace_command(payload: Parameters<typeof trpc.content.executeWorkspaceCommand.mutate>[0]) {
      return trpc_call(trpc.content.executeWorkspaceCommand.mutate(payload))
    },
    async begin_upload_batch(payload: Parameters<typeof trpc.content.beginUploadBatch.mutate>[0]) {
      return trpc_call(trpc.content.beginUploadBatch.mutate(payload))
    },
    async list_stories() {
      return trpc_call(trpc.content.listStories.query())
    },

    get_story_body,

    async create_story(markdown: string, base_title_revision: number | null, confirm_reference_history?: string) {
      return trpc_call(trpc.content.createStory.mutate({ markdown, base_title_revision, confirm_reference_history }))
    },

    async update_story(id: number, payload: { markdown: string, base_revision: number, base_namespace_revision?: number | null, base_title_revision?: number | null, confirm_reference_history?: string }) {
      return trpc_call(trpc.content.updateStory.mutate({ id, ... payload }))
    },

    async rewrite_draft_references(id: number, payload: { markdown: string, base_namespace_revision: number | null, base_title_revision: number | null }) {
      return trpc_call(trpc.content.rewriteDraftReferences.mutate({ id, ... payload }))
    },
    async get_title_reference_version() {
      return trpc_call(trpc.content.getTitleReferenceVersion.query())
    },
    async get_attachment_workspace(id: number) {
      return trpc_call(trpc.content.getAttachmentWorkspace.query({ id }))
    },
    async list_upload_sessions(id: number) {
      return trpc_call(trpc.content.listUploadSessions.query({ id }))
    },
    async adopt_upload_session(session_id: string) {
      return trpc_call(trpc.content.adoptUploadSession.mutate({ session_id }))
    },
    async initialize_upload_session(session_id: string) {
      return trpc_call(trpc.content.initializeUploadSession.mutate({ session_id }))
    },
    async get_upload_session(session_id: string) {
      return trpc_call(trpc.content.getUploadSession.query({ session_id }))
    },
    async resume_upload_session(session_id: string) {
      return trpc_call(trpc.content.resumeUploadSession.mutate({ session_id }))
    },
    async seal_upload_session(session_id: string) {
      return trpc_call(trpc.content.sealUploadSession.mutate({ session_id }))
    },
    async cancel_upload_session(session_id: string) {
      return trpc_call(trpc.content.cancelUploadSession.mutate({ session_id }))
    },
    async sign_upload_session_part(session_id: string, part: number, md5: string) {
      return trpc_call(trpc.content.signUploadSessionPart.mutate({ session_id, part, md5 }))
    },

    async get_delete_impact(input: { kind: 'story', id: number } | { kind: 'attachment', id: number, targets: number[] }) {
      return trpc_call(trpc.content.getDeleteImpact.query(input))
    },

    async delete_story(id: number) {
      await trpc_call(trpc.content.deleteStory.mutate({ id }))
    },

    /** Signs a short-lived object GET that saves the attachment under its row name. */
    async sign_attachment_download(story_id: number, file_name: string, role: 'avif' | 'original' | 'redacted_avif' = 'avif') {
      return trpc_call(trpc.content.signAttachmentDownload.mutate({ story_id, file_name, role }))
    },
    async image_editor_source(id: number, version: string, redacted = false) {
      return trpc_call(trpc.content.imageEditorSource.query({ id, version, redacted }))
    },

  }

  return {
    auth,
    profile,
    admin,
    content,
  }
}
