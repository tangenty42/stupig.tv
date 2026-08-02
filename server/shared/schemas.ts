import dayjs from 'dayjs'
import * as z from 'zod'

const iso_date_string = z.preprocess(
  (value) => {
    if (value === '' || value === null || value === undefined)
      return null
    if (value instanceof Date)
      return value.toISOString()
    if (typeof value === 'string')
      return dayjs(value).toISOString()
    return value
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

function build_sequence_set(min_run: number) {
  const set = new Set<string>()
  for (const source of sequence_sources) {
    for (let index = 0; index + min_run <= source.length; index ++) {
      const run = source.slice(index, index + min_run)
      set.add(run)
      set.add([... run].reverse().join(''))
    }
  }
  return set
}

const min_sequence_run = 4
const sequence_set = build_sequence_set(min_sequence_run)

function has_sequential_run(password: string) {
  const lower = password.toLowerCase()
  for (let index = 0; index + min_sequence_run <= lower.length; index ++) {
    if (sequence_set.has(lower.slice(index, index + min_sequence_run))) {
      return true
    }
  }
  return false
}

const password_policy_schema = z.string()
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

export const form_schema = {
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

  profile_birthday_update: z.object({
    birthday: iso_date_string.nullable(),
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
}

export type FormName = keyof typeof form_schema

type FormDefaults = {
  [Name in FormName]: z.input<(typeof form_schema)[Name]>
}

export const form_default = {
  register: {
    username: '',
    phone: '',
    password: '',
    confirm_password: '',
    otp: '',
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
} satisfies FormDefaults
