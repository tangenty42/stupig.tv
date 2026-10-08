import type { AppRouter } from '@server/trpc/router'
import type { PermissionGrant } from '@shared/permissions'
import type { ContentAttachmentReplaceRequest, ContentStoryDetail, ContentTaskKind, ContentTaskUploadedPart, ContentUploadSignRequest } from '@shared/types/content'
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
  async function get_story(id: number, base_updated_at: string, base_viewer_key: string): Promise<ContentStoryDetail | null>
  async function get_story(id: number, base_updated_at?: string, base_viewer_key?: string): Promise<ContentStoryDetail | null> {
    return trpc_call(trpc.content.getStory.query(base_updated_at === undefined ? { id } : { id, base_updated_at, base_viewer_key }))
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

    async create_story(markdown: string) {
      return trpc_call(trpc.content.createStory.mutate({ markdown }))
    },

    async update_story(id: number, payload: { markdown: string, base_revision: number, delete_files?: string[] }) {
      return trpc_call(trpc.content.updateStory.mutate({ id, ... payload }))
    },

    async delete_story(id: number) {
      await trpc_call(trpc.content.deleteStory.mutate({ id }))
    },

    async get_bilibili_video_cards(hrefs: string[]) {
      return trpc_call(trpc.content.getBilibiliVideoCards.query({ hrefs }))
    },

    async sign_attachment_upload(payload: ContentUploadSignRequest) {
      return trpc_call(trpc.content.signAttachmentUpload.mutate(payload))
    },

    /** Signs a short-lived object GET that saves the attachment under its row name. */
    async sign_attachment_download(story_id: number, file_name: string) {
      return trpc_call(trpc.content.signAttachmentDownload.mutate({ story_id, file_name }))
    },

    async confirm_attachment_upload(story_id: number, key: string, file_name: string) {
      return trpc_call(trpc.content.confirmAttachmentUpload.mutate({ story_id, key, file_name }))
    },

    async rename_attachment(id: number, old_file_name: string, file_name: string) {
      return trpc_call(trpc.content.renameAttachment.mutate({ id, old_file_name, file_name }))
    },

    async replace_attachment(payload: ContentAttachmentReplaceRequest) {
      // The staged object the payload references was uploaded through the
      // editor's Uppy instance (signed by signAttachmentUpload), so this call
      // is only the land-the-row mutation.
      return trpc_call(trpc.content.replaceAttachment.mutate(payload))
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

    /* ---- 附件任务队列（docs/content-task-refactor.md §7）---- */

    async preflight_task(story_id: number, kind: ContentTaskKind, payload: Record<string, unknown>) {
      return trpc_call(trpc.content.preflightTask.query({ story_id, kind: kind as 'upload', payload }))
    },

    async create_task(story_id: number, kind: ContentTaskKind, payload: Record<string, unknown>, client_id: string | null = null) {
      return trpc_call(trpc.content.createTask.mutate({ story_id, kind: kind as 'upload', payload, client_id }))
    },

    async cancel_task(task_id: number) {
      return trpc_call(trpc.content.cancelTask.mutate({ task_id }))
    },

    async resume_task(task_id: number) {
      return trpc_call(trpc.content.resumeTask.mutate({ task_id }))
    },

    async list_scope_tasks(story_id: number) {
      return trpc_call(trpc.content.listScopeTasks.query({ story_id }))
    },

    async sign_task_parts(task_id: number, item_id: number, part_numbers: number[]) {
      return trpc_call(trpc.content.signTaskParts.mutate({ task_id, item_id, part_numbers }))
    },

    async report_task_item(payload: { task_id: number, item_id: number, status: 'progress' | 'completed', bytes_done?: number, parts?: ContentTaskUploadedPart[] }) {
      return trpc_call(trpc.content.reportTaskItem.mutate(payload))
    },

    async resume_task_item(task_id: number, item_id: number) {
      return trpc_call(trpc.content.resumeTaskItem.query({ task_id, item_id }))
    },
  }

  return {
    auth,
    profile,
    admin,
    content,
  }
}
