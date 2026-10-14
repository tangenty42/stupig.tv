import { afterEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'

const { useCaptcha } = await import('./useCaptcha')

afterEach(() => {
  vi.unstubAllGlobals()
})

function setup(debug: boolean) {
  vi.stubGlobal('useRuntimeConfig', () => ({ public: { aliyun: { captcha: { appId: 'app-id' } }, app: { captcha: { debug } } } }))
  vi.stubGlobal('useState', (_key: string, init: () => unknown) => ref(init()))
}

describe('captcha debug client', () => {
  it('the validated development flag suppresses SDK initialization and returns no fabricated tokens', async () => {
    setup(true)
    const sdk = vi.fn(() => {
      throw new Error('SDK must not run in debug mode')
    })
    vi.stubGlobal('initAlicom4', sdk)
    const captcha = useCaptcha()
    await expect(captcha.verify()).resolves.toBeUndefined()
    expect(sdk).not.toHaveBeenCalled()
    expect(captcha.showing.value).toBe(false)
  })

  it('without debug, SDK initialization is still required', async () => {
    setup(false)
    vi.stubGlobal('initAlicom4', undefined)
    await expect(useCaptcha().verify()).rejects.toThrow('验证码加载失败，请刷新重试')
  })
})
