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

export const password_policy_schema = z.string()
  .min(8, '密码至少 8 位')
  .max(64, '密码最多 64 位')
  .regex(/\D/, '密码不能为纯数字')
  // eslint-disable-next-line regexp/optimal-quantifier-concatenation, regexp/optimal-lookaround-quantifier -- intentional: forbid 4+ repeated chars
  .regex(/^(?!.*(.)\1{3,}).*$/, '密码不能包含连续重复 4 次及以上的字符')

export const schema = {
  register: z.object({
    username: z.string().min(2, '用户名至少 2 位').max(32, '用户名最多 32 位'),
    phone: phone_schema,
    password: password_policy_schema,
    confirm_password: z.string().min(1, '请确认密码'),
    otp: z.string().length(6, '验证码为 6 位'),
  })
    .refine(data => data.password === data.confirm_password, {
      message: '两次输入的密码不一致',
      path: ['confirm_password'],
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
    operate_for: z.coerce.number().int().positive()
      .optional()
      .nullable(),
  }),

  profile_operate_password_reset: z.object({
    new_password: password_policy_schema,
    confirm_new_password: z.string().min(1, '请确认新密码'),
  })
    .refine(data => data.new_password === data.confirm_new_password, {
      message: '两次输入的密码不一致',
      path: ['confirm_new_password'],
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
    .refine(data => data.new_password === data.confirm_new_password, {
      message: '两次输入的密码不一致',
      path: ['confirm_new_password'],
    }),

  profile_change_password_by_otp: z.object({
    otp: z.string().length(6, '验证码为 6 位'),
    new_password: password_policy_schema,
    confirm_new_password: z.string().min(1, '请确认新密码'),
  })
    .refine(data => data.new_password === data.confirm_new_password, {
      message: '两次输入的密码不一致',
      path: ['confirm_new_password'],
    }),

  profile_change_phone: z.object({
    new_phone: phone_schema,
    old_otp: z.string().length(6, '验证码为 6 位'),
    new_otp: z.string().length(6, '验证码为 6 位'),
  }),

  admin_user_update: z.object({
    username: z.string().min(2).max(32)
      .optional(),
    password: z.string().min(8).max(64)
      .optional()
      .nullable(),
    phone: phone_schema.optional().nullable(),
    birthday: iso_date_string.optional(),
    is_verified: z.boolean().optional(),
    verified_note: z.string().max(255).optional()
      .nullable(),
    is_admin: z.boolean().optional(),
  }),

  admin_user_role: z.object({
    is_admin: z.boolean(),
  }),

  admin_profile_verification: z.object({
    is_verified: z.boolean(),
    verified_note: z.string().max(255).optional()
      .nullable(),
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
