import type { AppRouter } from '@server/trpc/router'
import type { PermissionGrant } from '@shared/permissions'
import type { ContentStoryDetail, ContentUploadSignRequest } from '@shared/types/content'
import type { inferRouterInputs } from '@trpc/server'

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

  async function get_story(id: number): Promise<ContentStoryDetail>
  async function get_story(id: number, base_updated_at: string): Promise<ContentStoryDetail | null>
  async function get_story(id: number, base_updated_at?: string): Promise<ContentStoryDetail | null> {
    return trpc_call(trpc.content.getStory.query(base_updated_at === undefined ? { id } : { id, base_updated_at }))
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

  const content = {
    async list_stories() {
      return trpc_call(trpc.content.listStories.query())
    },

    get_story,

    async create_story(markdown: string, claim_files: string[] = []) {
      return trpc_call(trpc.content.createStory.mutate({ markdown, claim_files }))
    },

    async update_story(id: number, payload: { markdown: string, base_revision: number, delete_files?: string[] }) {
      await trpc_call(trpc.content.updateStory.mutate({ id, ... payload }))
    },

    async delete_story(id: number) {
      await trpc_call(trpc.content.deleteStory.mutate({ id }))
    },

    async get_bilibili_video_cards(hrefs: string[]) {
      return trpc_call(trpc.content.getBilibiliVideoCards.query({ hrefs }))
    },

    async upload_attachment(
      id: number,
      file: File,
      file_name?: string,
      on_progress?: (progress: number, loaded: number, total: number) => void,
      signal?: AbortSignal,
    ) {
      const form = new FormData()
      form.append('story_id', String(id))
      if (file_name)
        form.append('file_name', file_name)
      form.append('file', file)

      return trpc_upload('content.uploadAttachment', form, on_progress, signal)
    },

    async sign_attachment_upload(payload: ContentUploadSignRequest) {
      return trpc_call(trpc.content.signAttachmentUpload.mutate(payload))
    },

    async confirm_attachment_upload(story_id: number, key: string, file_name: string) {
      return trpc_call(trpc.content.confirmAttachmentUpload.mutate({ story_id, key, file_name }))
    },

    async rename_attachment(id: number, old_file_name: string, file_name: string) {
      return trpc_call(trpc.content.renameAttachment.mutate({ id, old_file_name, file_name }))
    },

    async replace_attachment(
      id: number,
      old_file_name: string,
      file: File,
      mode: 'keep-name' | 'new-name',
      on_progress?: (progress: number, loaded: number, total: number) => void,
      signal?: AbortSignal,
    ) {
      const form = new FormData()
      form.append('story_id', String(id))
      form.append('old_file_name', old_file_name)
      form.append('mode', mode)
      form.append('file', file)

      return trpc_upload('content.replaceAttachment', form, on_progress, signal)
    },

    /** Uploads the redacted bitmap the 删减版 editor exported for an encrypted image. */
    async create_abridged_attachment(id: number, source_file_name: string, file: File) {
      const form = new FormData()
      form.append('story_id', String(id))
      form.append('source_file_name', source_file_name)
      form.append('file', file)

      return trpc_upload('content.createAbridgedAttachment', form)
    },

    async delete_attachment(id: number, file_name: string, markdown: string, base_revision: number) {
      await trpc_call(trpc.content.deleteAttachment.mutate({ id, file_name, markdown, base_revision }))
    },

    async delete_orphan_attachment(file_name: string) {
      await trpc_call(trpc.content.deleteOrphanAttachment.mutate({ file_name }))
    },

    async list_orphan_attachments() {
      return trpc_call(trpc.content.listOrphanAttachments.query())
    },

    async move_attachment(id: number, file_name: string, target_folder: string | null) {
      return trpc_call(trpc.content.moveAttachment.mutate({ id, file_name, target_folder }))
    },

    async move_attachments(id: number, moves: { file_name: string, target_folder: string | null }[]) {
      return trpc_call(trpc.content.moveAttachments.mutate({ id, moves }))
    },

    async encrypt_attachments(id: number, file_names: string[]) {
      return trpc_call(trpc.content.encryptAttachments.mutate({ id, file_names }))
    },

    async decrypt_attachments(id: number, file_names: string[]) {
      return trpc_call(trpc.content.decryptAttachments.mutate({ id, file_names }))
    },

    async create_folder(id: number, folder: string) {
      return trpc_call(trpc.content.createFolder.mutate({ id, folder }))
    },

    async delete_folder(id: number, folder: string) {
      return trpc_call(trpc.content.deleteFolder.mutate({ id, folder }))
    },

    async move_folder(id: number, source_folder: string, new_folder: string) {
      return trpc_call(trpc.content.moveFolder.mutate({ id, source_folder, new_folder }))
    },
  }

  return {
    auth,
    profile,
    admin,
    content,
  }
}
