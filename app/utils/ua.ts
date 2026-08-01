import { UAParser } from 'ua-parser-js'

const UNKNOWN_DEVICE_LABEL = '未知设备'

export function ua_label(user_agent: string | null | undefined): string {
  if (! user_agent) {
    return UNKNOWN_DEVICE_LABEL
  }

  const result = UAParser(user_agent)
  const os = result.os.name
  const browser = result.browser.name

  if (os && browser) {
    return `${os} · ${browser}`
  }
  if (os || browser) {
    return (os ?? browser)!
  }
  return UNKNOWN_DEVICE_LABEL
}
