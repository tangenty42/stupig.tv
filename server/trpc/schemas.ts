import { link_file_name_byte_length, link_file_name_illegal_chars, link_file_name_reserved_base } from '@shared/content-markdown'
import { env } from '@shared/env'
import { form_schema, phone_schema } from '@shared/schemas'
import * as z from 'zod'

const markdown_input = z.string()
  .min(1, '内容不能为空')
  .refine(value => link_file_name_byte_length(value) <= env.CONTENT_STORY_MARKDOWN_MAX_BYTES, '内容太长了')

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

const content_story_update = z.object({
  markdown: markdown_input,
  delete_files: z.array(z.string().min(1).max(255)).max(500).optional().default([]),
  base_revision: z.number().int().positive(),
})

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
  },

  content: {
    get_story: public_id_input.extend({
      base_updated_at: z.string().min(1).optional(),
    }),
    create_story: z.object({
      markdown: markdown_input,
      /** Orphan attachment file names (story_id NULL) to adopt into the new story. */
      claim_files: z.array(z.string().min(1).max(255)).max(200).default([]),
    }),
    update_story: public_id_input.extend(content_story_update.shape),
    delete_story: public_id_input,
    upload_attachment: z.instanceof(FormData),
    replace_attachment: z.instanceof(FormData),
    rename_attachment: public_id_input.extend({
      old_file_name: z.string().min(1).max(120),
      file_name: z.string()
        .trim()
        .min(1, '文件名不能为空')
        .max(120, '文件名不能超过 120 个字符')
        .refine(name => ! name.startsWith('.'), '文件名不能以点开头')
        .refine(name => ! name.endsWith('.'), '文件名不能以点结尾')
        .refine(name => ! name.match(link_file_name_illegal_chars), '文件名包含不支持的字符')
        .refine(name => link_file_name_byte_length(name) <= env.CONTENT_LINK_FILE_NAME_MAX_BYTES, '文件名太长')
        .refine(name => ! link_file_name_reserved_base.test(name.split('.')[0] ?? ''), '文件名是系统保留名称'),
    }),
    delete_attachment: public_id_input.extend({
      file_name: z.string().min(1).max(120),
      markdown: markdown_input,
      base_revision: z.number().int().positive(),
    }),
    delete_orphan_attachment: z.object({
      file_name: z.string().min(1).max(255),
    }),
    get_bilibili_video_cards: z.object({
      hrefs: z.array(z.string().max(2048)).min(1).max(20),
    }),
  },
}
