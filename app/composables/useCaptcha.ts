interface CaptchaResult {
  lot_number: string
  captcha_output: string
  pass_token: string
  gen_time: string
}

interface CaptchaPending {
  resolve: (result: CaptchaResult) => void
  reject: (error?: unknown) => void
}

interface CaptchaObj {
  onNextReady: (callback: () => void) => CaptchaObj
  onSuccess: (callback: () => void) => CaptchaObj
  onFail: (callback: (fail_obj: unknown) => void) => CaptchaObj
  onError: (callback: (error: { code: string, msg: string, desc?: { detail?: string } }) => void) => CaptchaObj
  onClose: (callback: () => void) => CaptchaObj
  getValidate: () => CaptchaResult | false
  showCaptcha: () => void
  reset: () => void
  destroy: () => void
}

declare function initAlicom4(
  config: { captchaId: string, product: string, language?: string },
  callback: (captcha_obj: CaptchaObj) => void,
): void

let captcha_obj: CaptchaObj | null = null
let captcha_init_pending: Promise<CaptchaObj> | null = null
let captcha_verify_pending: CaptchaPending | null = null
let captcha_ready = false
let captcha_showing_state: ReturnType<typeof useState<boolean>> | null = null

function get_captcha_showing_state() {
  if (! captcha_showing_state) {
    captcha_showing_state = useState<boolean>('captcha_showing', () => false)
  }

  return captcha_showing_state
}

function clear_captcha_pending(error?: unknown) {
  const pending = captcha_verify_pending

  captcha_verify_pending = null
  get_captcha_showing_state().value = false

  if (! pending) {
    return
  }

  if (error === undefined) {
    return
  }

  pending.reject(error)
}

function destroy_captcha() {
  captcha_obj?.destroy()
  captcha_obj = null
  captcha_init_pending = null
  captcha_ready = false
}

function bind_captcha_events(obj: CaptchaObj) {
  obj
    .onNextReady(() => {
      captcha_ready = true

      if (captcha_verify_pending) {
        obj.showCaptcha()
        get_captcha_showing_state().value = true
      }
    })
    .onSuccess(() => {
      const result = obj.getValidate()

      get_captcha_showing_state().value = false
      obj.reset()

      if (result && captcha_verify_pending) {
        captcha_verify_pending.resolve(result)
        captcha_verify_pending = null
        return
      }

      clear_captcha_pending(new Error('验牌失败！'))
    })
    .onFail(() => {
      obj.reset()
      get_captcha_showing_state().value = false
    })
    .onError((error) => {
      destroy_captcha()
      clear_captcha_pending(new Error(error.msg || '不兑，验证码有问题'))
    })
    .onClose(() => {
      obj.reset()
      clear_captcha_pending(new Error('用户打断了施法'))
    })
}

function get_captcha_obj(captcha_id: string): Promise<CaptchaObj> {
  if (captcha_obj) {
    return Promise.resolve(captcha_obj)
  }

  if (captcha_init_pending) {
    return captcha_init_pending
  }

  captcha_init_pending = new Promise<CaptchaObj>((resolve, reject) => {
    if (typeof initAlicom4 === 'undefined') {
      reject(new Error('验证码加载失败，请刷新重试'))
      return
    }

    initAlicom4({
      captchaId: captcha_id,
      product: 'bind',
    }, (obj) => {
      captcha_obj = obj
      bind_captcha_events(obj)
      resolve(obj)
    })
  }).then((obj) => {
    captcha_init_pending = null
    return obj
  }).catch((error) => {
    captcha_init_pending = null
    throw error
  })

  return captcha_init_pending
}

export function useCaptcha() {
  const config = useRuntimeConfig()
  const captcha_id = config.public.captcha_app_id
  const showing = get_captcha_showing_state()

  async function verify(): Promise<CaptchaResult> {
    if (import.meta.server) {
      throw new Error('verify() cannot run on the server')
    }

    if (captcha_verify_pending) {
      throw new Error('不兑！我成替身了？')
    }

    const obj = await get_captcha_obj(captcha_id)

    return new Promise((resolve, reject) => {
      captcha_verify_pending = { resolve, reject }

      if (captcha_ready) {
        obj.showCaptcha()
        showing.value = true
      }
    })
  }

  return { verify, showing }
}
