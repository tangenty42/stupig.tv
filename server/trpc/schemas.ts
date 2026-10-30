import { link_file_name_byte_length } from '@shared/content-markdown'
import { upload_part_schema, upload_session_schema } from '@shared/content-upload'
import { is_valid_permission_grant, normalize_permission_grants } from '@shared/permissions'
import { form_schema, phone_schema } from '@shared/schemas'
import { settings } from '@shared/settings'
import * as z from 'zod'

const markdown_input = z.string()
  .min(1, '内容不能为空')
  .refine(value => link_file_name_byte_length(value) <= settings.app.content.story.markdownMaxBytes, '内容太长了')

const captcha_input = z.object({
  lot_number: z.string().optional(),
  captcha_output: z.string().optional(),
  pass_token: z.string().optional(),
  gen_time: z.string().optional(),
})

const operate_for_input = z.object({
  operate_for: z.coerce.number().int().positive(),
})

const public_id_input = z.object({
  id: z.coerce.number().int().positive(),
})

const permission_grant_input = z.object({
  field: z.string(),
  level: z.string(),
}).refine(grant => is_valid_permission_grant(grant.field, grant.level), '权限项不合法')

const content_story_update = z.object({
  markdown: markdown_input,
  base_revision: z.number().int().positive(),
})

const draft_id = z.string().regex(/^[a-f0-9]{32}$/)
const draft_lease = z.object({ page_id: draft_id, epoch: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), token: z.string().regex(/^[a-f0-9]{64}$/) })
export const draft_schema = {
  create: z.object({ request_id: draft_id }),
  get: z.object({ id: draft_id.optional(), story_id: z.number().int().positive().optional(), lease: draft_lease.optional() }).refine(value => !! value.id !== !! value.story_id, '必须指定一份草稿'),
  list: z.object({ after: draft_id.or(z.literal('')).default(''), limit: z.number().int().min(1).max(100).default(30) }).default({ after: '', limit: 30 }),
  acquire: z.object({ id: draft_id, expected_epoch: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER - 1), page_id: draft_id, token: z.string().regex(/^[a-f0-9]{64}$/) }),
  command: z.object({
    id: draft_id, lease: draft_lease, seq: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    kind: z.enum(['sync', 'release', 'publish', 'reset', 'delete']),
    markdown: z.string().max(settings.app.content.story.markdownMaxBytes * 2).optional(),
    base_namespace_revision: z.number().int().nonnegative().nullable().default(null),
    base_title_revision: z.number().int().nonnegative().nullable().default(null),
    expected_revision: z.number().int().positive().optional(),
    confirm_reference_history: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  }).refine(value => (value.markdown === undefined || ['sync', 'release'].includes(value.kind)) && (! ['publish', 'reset'].includes(value.kind) || value.expected_revision !== undefined), '草稿命令与正文或确认版本不匹配'),
}

export const api_schema = {
  auth: {
    register: form_schema.register,
    login_with_password: z.intersection(form_schema.login_with_password, captcha_input),
    login_with_phone: form_schema.login_with_phone,
    send_otp: z.intersection(z.object({
      phone: phone_schema.optional(),
      purpose: z.enum(['register', 'login', 'change_password', 'verify_old_phone', 'change_phone']),
    }), captcha_input),
    otp_cooldown: z.object({
      phone: phone_schema,
    }).optional(),
  },

  profile: {
    get: public_id_input,
    update_birthday: z.object({
      ... form_schema.profile_birthday_update.shape,
      operate_for: z.coerce.number().int().positive().optional().nullable(),
    }),
    get_sessions: operate_for_input.partial().optional(),
    force_logout_session: z.object({
      id: z.coerce.number().int().positive(),
      operate_for: z.coerce.number().int().positive().optional(),
    }),
    reset_password_for: operate_for_input.extend(form_schema.profile_operate_password_reset.shape),
    change_password: z.intersection(form_schema.profile_change_password, captcha_input),
    change_password_by_otp: z.intersection(form_schema.profile_change_password_by_otp, captcha_input),
    change_phone_for: operate_for_input.extend(form_schema.profile_operate_phone_change.shape),
    change_phone: z.intersection(form_schema.profile_change_phone, captcha_input),
    upload_avatar: z.instanceof(FormData),
    delete_avatar: operate_for_input.partial().optional(),
  },

  admin: {
    storage_audit_findings: z.object({ after_id: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(100).default(50) }),
    list_users: z.object({
      page: z.coerce.number().int().positive().default(1),
      page_size: z.coerce.number().int().positive().default(10),
      filter: z.string().optional(),
    }),
    set_banned: public_id_input.extend({ banned: z.boolean() }),
    force_logout: public_id_input,
    set_verification: public_id_input.extend({
      is_verified: z.boolean(),
      verified_note: z.string().max(255).optional().nullable(),
    }),
    set_role: public_id_input.extend({
      is_admin: z.boolean(),
    }),
    set_permissions: public_id_input.extend({
      permissions: z.array(permission_grant_input).max(100).transform(grants => normalize_permission_grants(grants)),
    }),
  },

  content: {
    delete_impact: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('story'), id: z.number().int().positive() }),
      z.object({ kind: z.literal('attachment'), id: z.number().int().positive(), targets: z.array(z.number().int().positive()).min(1).max(settings.app.content.workspace.batchLimit) }),
    ]),
    upload_session: upload_session_schema,
    upload_session_part: upload_part_schema,
    get_attachment_workspace: public_id_input,
    get_story_body: public_id_input.extend({ base_representation_version: z.string().regex(/^[\da-f]{64}$/).optional() }),
    create_story: z.object({
      markdown: markdown_input,
      base_title_revision: z.number().int().nonnegative().nullable().default(null),
      confirm_reference_history: z.string().regex(/^[\da-f]{64}$/).optional(),
    }),
    update_story: public_id_input.extend(content_story_update.shape).extend({
      base_namespace_revision: z.number().int().nonnegative().nullable().default(null),
      base_title_revision: z.number().int().nonnegative().nullable().default(null),
      confirm_reference_history: z.string().regex(/^[\da-f]{64}$/).optional(),
    }),
    rewrite_draft_references: z.object({
      id: z.number().int().nonnegative(),
      markdown: markdown_input.or(z.literal('')),
      base_namespace_revision: z.number().int().nonnegative().nullable(),
      base_title_revision: z.number().int().nonnegative().nullable(),
    }),
    delete_story: public_id_input,
    image_editor_source: z.object({ id: z.number().int().positive(), version: z.string().regex(/^[\da-f]{64}$/), redacted: z.boolean().default(false) }),
    sign_attachment_download: z.object({
      story_id: z.coerce.number().int().positive(),
      file_name: z.string().min(1).max(255),
      role: z.enum(['avif', 'original', 'redacted_avif']).default('avif'),
    }),
  },
}
