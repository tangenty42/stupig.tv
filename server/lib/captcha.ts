import { createHmac } from 'node:crypto'
import { ApiError } from '@server/errors/ApiError'
import { env } from '@shared/env'

interface CaptchaParams {
  lot_number: string
  captcha_output: string
  pass_token: string
  gen_time: string
}

export async function verify_captcha(params: CaptchaParams | undefined): Promise<void> {
  if (! env.CAPTCHA_APP_ID) {
    return
  }

  if (! params?.lot_number || ! params?.captcha_output || ! params?.pass_token || ! params?.gen_time) {
    throw new ApiError(400, 'Wow~这招厉害！')
  }

  const sign_token = createHmac('sha256', env.CAPTCHA_APP_KEY!)
    .update(params.lot_number)
    .digest('hex')

  const url = `https://captcha.alicaptcha.com/validate?captcha_id=${encodeURIComponent(env.CAPTCHA_APP_ID)}`

  const body = new URLSearchParams({
    lot_number: params.lot_number,
    captcha_output: params.captcha_output,
    pass_token: params.pass_token,
    gen_time: params.gen_time,
    sign_token,
  })

  let result: { result: string, reason: string }

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    })
    if (! response.ok) {
      throw new Error(`HTTP ${response.status}`)
    }
    result = await response.json() as typeof result
  }
  catch {
    // Aliyun captcha service is down; let it pass (fail-open)
    return
  }

  if (result.result !== 'success') {
    throw new ApiError(403, '汝果真人机乎？！')
  }
}
