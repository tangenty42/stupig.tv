import dayjs from 'dayjs'
import * as z from 'zod'

export const iso_date_string = z.preprocess(
  (val) => {
    if (val === '' || val === null || val === undefined)
      return null
    if (val instanceof Date)
      return val.toISOString()
    if (typeof val === 'string')
      return dayjs(val).toISOString()
    return val
  },
  z.string(),
)

export const phone_schema = z.string().regex(/^1[3-9]\d{9}$/, '手机号格式不正确')

const sequence_sources = [
  'abcdefghijklmnopqrstuvwxyz',
  // Looped so wrap-around runs like 89012 / 09876 are covered
  '01234567890',
  'qwertyuiop',
  'asdfghjkl',
  'zxcvbnm',
  '1qaz2',
  '2wsx3',
  '3edc4',
  '4rfv5',
  '5tgb6',
  '6yhn7',
  '7ujm8',
]

function build_sequence_set(min_run: number): Set<string> {
  const set = new Set<string>()
  for (const source of sequence_sources) {
    for (let i = 0; i + min_run <= source.length; i ++) {
      const run = source.slice(i, i + min_run)
      set.add(run)
      set.add([...run].reverse().join(''))
    }
  }
  return set
}

const min_sequence_run = 4
const sequence_set = build_sequence_set(min_sequence_run)

function has_sequential_run(password: string): boolean {
  const lower = password.toLowerCase()
  for (let i = 0; i + min_sequence_run <= lower.length; i ++) {
    if (sequence_set.has(lower.slice(i, i + min_sequence_run))) {
      return true
    }
  }
  return false
}

export const password_policy_schema = z.string()
  .min(8, '密码至少 8 位')
  .max(64, '密码最多 64 位')
  .regex(/\D/, '密码不能为纯数字')
  // eslint-disable-next-line regexp/optimal-quantifier-concatenation, regexp/optimal-lookaround-quantifier -- intentional: forbid 4+ repeated chars
  .regex(/^(?!.*(.)\1{3,}).*$/, '密码不能包含连续重复 4 次及以上的字符')
  .superRefine((value, ctx) => {
    if (has_sequential_run(value)) {
      ctx.addIssue({ code: 'custom', message: `密码不能包含连续 ${min_sequence_run} 个及以上有规律的字符` })
    }
  })

export const schema = {
  register: z.object({
    username: z.string().min(2, '用户名至少 2 位').max(32, '用户名最多 32 位'),
    phone: phone_schema,
    password: password_policy_schema,
    confirm_password: z.string().min(1, '请确认密码'),
    otp: z.string().length(6, '验证码为 6 位'),
  })
    .superRefine((data, ctx) => {
      if (data.password !== data.confirm_password) {
        ctx.addIssue({ code: 'custom', message: '两次输入的密码不一致', path: ['confirm_password'] })
      }
    }),

  login_with_password: z.object({
    username_or_phone: z.string().min(1, '请输入用户名或手机号'),
    password: z.string().min(1, '请输入密码'),
  }),

  login_with_phone: z.object({
    phone: phone_schema,
    otp: z.string().length(6, '验证码为 6 位'),
  }),

  otp_cooldown: z.object({
    phone: phone_schema,
    purpose: z.enum(['register', 'login', 'change_password', 'verify_old_phone', 'change_phone']),
  }),

  send_otp: z.object({
    phone: phone_schema,
    purpose: z.enum(['register', 'login', 'change_password', 'verify_old_phone', 'change_phone']),
  }),

  profile_birthday_update: z.object({
    birthday: iso_date_string.nullable(),
    operate_for: z.coerce.number().int().positive().optional().nullable(),
  }),

  profile_operate_password_reset: z.object({
    new_password: password_policy_schema,
    confirm_new_password: z.string().min(1, '请确认新密码'),
  })
    .superRefine((data, ctx) => {
      if (data.new_password !== data.confirm_new_password) {
        ctx.addIssue({ code: 'custom', message: '两次输入的密码不一致', path: ['confirm_new_password'] })
      }
    }),

  profile_operate_phone_change: z.object({
    new_phone: phone_schema,
  }),

  profile_operate_target: z.object({
    operate_for: z.coerce.number().int().positive(),
  }),

  profile_change_password: z.object({
    old_password: z.string().min(1, '请输入旧密码'),
    new_password: password_policy_schema,
    confirm_new_password: z.string().min(1, '请确认新密码'),
  })
    .superRefine((data, ctx) => {
      if (data.new_password !== data.confirm_new_password) {
        ctx.addIssue({ code: 'custom', message: '两次输入的密码不一致', path: ['confirm_new_password'] })
      }
    }),

  profile_change_password_by_otp: z.object({
    otp: z.string().length(6, '验证码为 6 位'),
    new_password: password_policy_schema,
    confirm_new_password: z.string().min(1, '请确认新密码'),
  })
    .superRefine((data, ctx) => {
      if (data.new_password !== data.confirm_new_password) {
        ctx.addIssue({ code: 'custom', message: '两次输入的密码不一致', path: ['confirm_new_password'] })
      }
    }),

  profile_change_phone: z.object({
    new_phone: phone_schema,
    old_otp: z.string().length(6, '验证码为 6 位'),
    new_otp: z.string().length(6, '验证码为 6 位'),
  }),

  admin_user_update: z.object({
    username: z.string().min(2).max(32).optional(),
    password: z.string().min(8).max(64).optional().nullable(),
    phone: phone_schema.optional().nullable(),
    birthday: iso_date_string.optional(),
    is_verified: z.boolean().optional(),
    verified_note: z.string().max(255).optional().nullable(),
    is_admin: z.boolean().optional(),
  }),

  admin_user_role: z.object({
    is_admin: z.boolean(),
  }),

  admin_profile_verification: z.object({
    is_verified: z.boolean(),
    verified_note: z.string().max(255).optional().nullable(),
  }),

  admin_user_password_reset: z.object({
    password: password_policy_schema,
  }),

  admin_user_phone_update: z.object({
    phone: phone_schema,
  }),

  profile_public_id: z.object({
    id: z.coerce.number().int().positive(),
  }),

  content_story_create: z.object({
    markdown: z.string().min(1, '内容不能为空').max(1024 * 1024, '内容太长了'),
  }),

  content_story_update: z.object({
    markdown: z.string().min(1, '内容不能为空').max(1024 * 1024, '内容太长了'),
    delete_files: z.array(z.string().min(1).max(255)).max(500).optional().default([]),
  }),

  content_attachment_rename: z.object({
    old_file_name: z.string().min(1).max(120),
    file_name: z.string()
      .trim()
      .min(1, '文件名不能为空')
      .max(120, '文件名不能超过 120 个字符')
      .refine(name => ! name.startsWith('.'), '文件名不能以点开头')
      .refine(name => ! [...name].some(char => '/\\<>:"?*|()[]'.includes(char)), '文件名包含不支持的字符'),
  }),

  content_attachment_delete: z.object({
    file_name: z.string().min(1).max(120),
    markdown: z.string().min(1, '内容不能为空').max(1024 * 1024, '内容太长了'),
  }),

  content_story_id: z.object({
    id: z.coerce.number().int().positive(),
  }),
}

export const form_default = {
  register: {
    username: '',
    phone: '',
    password: '',
    confirm_password: '',
    otp: '',
    purpose: 'register',
  },
  login_with_password: {
    username_or_phone: '',
    password: '',
  },
  login_with_phone: {
    phone: '',
    otp: '',
  },
  profile_change_password: {
    old_password: '',
    new_password: '',
    confirm_new_password: '',
  },
  profile_change_password_by_otp: {
    otp: '',
    new_password: '',
    confirm_new_password: '',
  },
  profile_change_phone: {
    new_phone: '',
    old_otp: '',
    new_otp: '',
  },
  profile_birthday_update: {
    birthday: null,
  },
  profile_operate_password_reset: {
    new_password: '',
    confirm_new_password: '',
  },
  profile_operate_phone_change: {
    new_phone: '',
  },
}
