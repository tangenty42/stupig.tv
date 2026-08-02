import type { AppRouter } from '@server/trpc/router'
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

export function useApi() {
  const { call: trpc_call, client: trpc, upload: trpc_upload } = useTrpcClient()

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

    async get_keywords() {
      const result = await trpc_call(trpc.admin.getKeywords.query())
      return { ... result, fields: [... result.fields] }
    },
  }

  const content = {
    async list_stories() {
      return trpc_call(trpc.content.listStories.query())
    },

    async get_story(id: number) {
      return trpc_call(trpc.content.getStory.query({ id }))
    },

    async create_story(markdown: string) {
      return trpc_call(trpc.content.createStory.mutate({ markdown }))
    },

    async update_story(id: number, payload: { markdown: string, base_updated_at: string, delete_files?: string[] }) {
      await trpc_call(trpc.content.updateStory.mutate({ id, ... payload }))
    },

    async delete_story(id: number) {
      await trpc_call(trpc.content.deleteStory.mutate({ id }))
    },

    async upload_attachment(
      id: number,
      file: File,
      on_progress?: (progress: number) => void,
      signal?: AbortSignal,
    ) {
      const form = new FormData()
      form.append('story_id', String(id))
      form.append('file', file)

      return trpc_upload('content.uploadAttachment', form, on_progress, signal)
    },

    async rename_attachment(id: number, old_file_name: string, file_name: string) {
      return trpc_call(trpc.content.renameAttachment.mutate({ id, old_file_name, file_name }))
    },

    async delete_attachment(id: number, file_name: string, markdown: string, base_updated_at: string) {
      await trpc_call(trpc.content.deleteAttachment.mutate({ id, file_name, markdown, base_updated_at }))
    },
  }

  return {
    auth,
    profile,
    admin,
    content,
  }
}
