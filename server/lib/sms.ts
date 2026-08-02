import type DypnsapiClass from '@alicloud/dypnsapi20170525'
import DypnsapiModule, { CheckSmsVerifyCodeRequest, SendSmsVerifyCodeRequest } from '@alicloud/dypnsapi20170525'
import { Config } from '@alicloud/openapi-client'
import { ApiError } from '@server/errors/ApiError'
import { env } from '@shared/env'

function is_dypnsapi_module_default(value: unknown): value is { default: typeof DypnsapiClass } {
  return typeof value === 'object' && value !== null && 'default' in value
}

// CJS interop: Nitro ESM bundling wraps CJS default behind .default
const Dypnsapi = is_dypnsapi_module_default(DypnsapiModule)
  ? DypnsapiModule.default
  : DypnsapiModule as unknown as typeof DypnsapiClass

const client = new Dypnsapi(new Config({
  accessKeyId: env.ALIYUN_ACCESS_KEY_ID,
  accessKeySecret: env.ALIYUN_ACCESS_KEY_SECRET,
  endpoint: env.ALIYUN_DYPNSAPI_ENDPOINT,
  regionId: env.ALIYUN_DYPNSAPI_REGION_ID,
}))

interface SendOtpSmsInput {
  phone: string
  out_id: string
}

export async function send_otp_sms(input: SendOtpSmsInput) {
  if (env.OTP_DEBUG) {
    return
  }

  const request = new SendSmsVerifyCodeRequest({
    phoneNumber: input.phone,
    signName: env.OTP_SMS_SIGN_NAME,
    templateCode: env.OTP_SMS_TEMPLATE_CODE,
    templateParam: JSON.stringify({
      code: '##code##',
      min: `${env.OTP_EXPIRES_MINUTES}`,
    }),
    schemeName: env.OTP_SMS_SCHEME_NAME,
    codeLength: 6,
    codeType: 1,
    validTime: env.OTP_EXPIRES_MINUTES * 60,
    returnVerifyCode: env.OTP_DEBUG,
    outId: input.out_id,
  })

  try {
    const response = await client.sendSmsVerifyCode(request)
    const body = response.body

    if (! body?.success || body.code !== 'OK') {
      console.log('[SMS] Aliyun SMS send fails: ', body)
      throw new ApiError(502, '短信发送失败')
    }
  }
  catch (error) {
    console.log('[SMS] unknown SMS send fails: ', error)
    throw new ApiError(502, '短信发送失败')
  }
}

interface CheckOtpSmsInput {
  phone: string
  code: string
}

export async function check_otp_sms(input: CheckOtpSmsInput) {
  if (env.OTP_DEBUG) {
    return
  }

  const request = new CheckSmsVerifyCodeRequest({
    phoneNumber: input.phone,
    verifyCode: input.code,
    schemeName: env.OTP_SMS_SCHEME_NAME,
  })

  try {
    const response = await client.checkSmsVerifyCode(request)
    const body = response.body

    if (! body?.success || body.code !== 'OK') {
      throw new ApiError(400, body?.message || '验证码校验失败')
    }

    if (body.model?.verifyResult !== 'PASS') {
      throw new ApiError(400, '验证码不正确或已过期')
    }
  }
  catch (error) {
    if (error instanceof ApiError) {
      throw error
    }

    if (error && typeof error === 'object') {
      const code = Reflect.get(error, 'code') as string | undefined
      const message = Reflect.get(error, 'message') as string | undefined
      if (code === 'VERIFY_CODE_NOT_MATCH') {
        throw new ApiError(400, '验证码不正确')
      }
      if (code === 'VERIFY_CODE_EXPIRED') {
        throw new ApiError(400, '验证码已过期，请重新发送')
      }
      throw new ApiError(400, message || '验证码校验失败')
    }

    throw new ApiError(400, '验证码校验失败')
  }
}
