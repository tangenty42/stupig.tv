import { ApiError } from '@server/errors/ApiError'
import { runtime_config } from './e2e-config'

const pending_codes = new Map<string, number>()

export async function send_otp_sms(input: { phone: string, out_id: string }) {
  const config = runtime_config()
  pending_codes.set(input.phone, Date.now() + config.app.otp.expiresMinutes * 60_000)
}

export async function check_otp_sms(input: { phone: string, code: string }) {
  runtime_config()
  const expires_at = pending_codes.get(input.phone)
  if (! expires_at || expires_at <= Date.now() || input.code !== '123456')
    throw new ApiError(400, '验证码不正确或已过期')
  pending_codes.delete(input.phone)
}
