import { runtime_config } from './e2e-config'

/** External CAPTCHA provider boundary; password/session authorization stays real. */
export async function verify_captcha() {
  runtime_config()
}
