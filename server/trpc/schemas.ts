import { runtime_config } from '@shared/config'
import { attachment_name_segment_violation, link_file_name_byte_length } from '@shared/content-markdown'
import { is_valid_permission_grant, normalize_permission_grants } from '@shared/permissions'
import { form_schema, phone_schema } from '@shared/schemas'
import * as z from 'zod'

const config = runtime_config()

const markdown_input = z.string()
  .min(1, '内容不能为空')
  .refine(value => link_file_name_byte_length(value) <= config.app.content.story.markdownMaxBytes, '内容太长了')

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
  delete_files: z.array(z.string().min(1).max(255)).max(500).optional().default([]),
  base_revision: z.number().int().positive(),
})

/** Content scope id: the story whose attachments the operation targets. */
const content_scope_input = z.object({
  id: z.coerce.number().int().positive(),
})

/**
 * One path segment (file base name or folder name) drawn from the shared name
 * rules, so the request schema and the service's name guard cannot drift apart.
 * The message is the shared one, which is also what the editor shows inline.
 */
function assert_valid_name_segment(name: string, ctx: z.RefinementCtx) {
  const violation = attachment_name_segment_violation(name)
  if (violation)
    ctx.addIssue({ code: 'custom', message: violation })
}

/** A bare file name or a (possibly nested) `folder/name` path. */
const attachment_path_input = z.string()
  .trim()
  .min(1, '文件名不能为空')
  .superRefine((name, ctx) => name.split('/').forEach(segment => assert_valid_name_segment(segment, ctx)))
  .refine(name => link_file_name_byte_length(name) <= config.app.content.link.fileNameMaxBytes, '文件名太长')

/**
 * A (possibly nested) folder path being CREATED or RENAMED, which is therefore
 * a new name and has to satisfy the name rules. Null targets the root.
 */
const folder_path_input = z.string()
  .trim()
  .min(1)
  .max(255)
  .superRefine((name, ctx) => name.split('/').forEach(segment => assert_valid_name_segment(segment, ctx)))
  .nullable()

/**
 * A path addressing something the scope already holds: the folder being renamed
 * or removed, a folder a file is moved into, a file being replaced.
 *
 * Deliberately NOT run through the name rules. Those exist to stop a NEW name
 * from faking the encryption marker, and an existing row's name is not new — it
 * is whatever earlier requests (or history) put there. Validating it makes such
 * a row impossible to operate on at all, which is how a folder that had acquired
 * a `.good` name became impossible to rename: the request was refused for its
 * SOURCE argument, before the service could even look at the new name.
 * Existence is the service's business (a missing folder is a 404).
 */
const existing_path_input = z.string().trim().min(1).max(255)

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
    get_story: public_id_input.extend({
      base_updated_at: z.string().min(1).optional(),
      base_viewer_key: z.string().min(1).optional(),
    }),
    create_story: z.object({
      markdown: markdown_input,
    }),
    update_story: public_id_input.extend(content_story_update.shape),
    delete_story: public_id_input,
    sign_attachment_upload: z.object({
      story_id: z.coerce.number().int().positive(),
      method: z.enum(['PUT', 'POST', 'GET', 'DELETE']),
      key: z.string().min(1).max(512),
      upload_id: z.string().min(1).max(256).optional(),
      part_number: z.coerce.number().int().min(1).max(10_000).optional(),
      content_type: z.string().max(255).nullable().optional(),
    }),
    sign_attachment_download: z.object({
      story_id: z.coerce.number().int().positive(),
      file_name: z.string().min(1).max(255),
    }),
    confirm_attachment_upload: z.object({
      story_id: z.coerce.number().int().positive(),
      key: z.string().min(1).max(512),
      file_name: z.string().min(1).max(255),
    }),
    replace_attachment: z.object({
      story_id: z.coerce.number().int().positive(),
      old_file_name: z.string().min(1).max(255),
      mode: z.enum(['keep-name', 'new-name']),
      key: z.string().min(1).max(512),
      file_name: z.string().min(1).max(255),
      content_type: z.string().max(255).nullable(),
    }),
    rename_attachment: content_scope_input.extend({
      old_file_name: z.string().min(1).max(255),
      file_name: attachment_path_input,
    }),
    delete_attachment: public_id_input.extend({
      file_name: z.string().min(1).max(255),
      markdown: markdown_input,
      base_revision: z.number().int().positive(),
    }),
    move_attachment: content_scope_input.extend({
      file_name: z.string().min(1).max(255),
      // Empty folders are editor-local, so the target folder is an existing
      // path the caller already knows: the move creates the prefix implicitly.
      target_folder: existing_path_input.nullable(),
    }),
    move_attachments: content_scope_input.extend({
      moves: z.array(z.object({
        file_name: z.string().min(1).max(255),
        target_folder: existing_path_input.nullable(),
      })).min(1).max(500),
    }),
    encrypt_attachments: content_scope_input.extend({
      file_names: z.array(z.string().min(1).max(255)).min(1).max(500),
    }),
    decrypt_attachments: content_scope_input.extend({
      file_names: z.array(z.string().min(1).max(255)).min(1).max(500),
    }),
    create_abridged_attachment: z.instanceof(FormData),
    create_folder: content_scope_input.extend({
      folder: folder_path_input.unwrap(),
    }),
    delete_folder: content_scope_input.extend({
      folder: existing_path_input,
    }),
    move_folder: content_scope_input.extend({
      // The source is where the folder IS, the destination is the new name it
      // takes: only the destination answers to the name rules.
      source_folder: existing_path_input,
      new_folder: folder_path_input.unwrap(),
    }),
    get_bilibili_video_cards: z.object({
      hrefs: z.array(z.string().max(2048)).min(1).max(20),
    }),
  },
}
