import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  config: {
    app: { otp: { debug: false, expiresMinutes: 5 } },
    aliyun: {
      dypns: { accessKeyId: 'test-id', accessKeySecret: 'test-secret', endpoint: 'test.invalid', regionId: 'test-region' },
      sms: { signName: 'test-sign', templateCode: 'test-template', schemeName: 'test-scheme' },
    },
  },
  send: vi.fn(),
  check: vi.fn(),
}))

vi.mock('@config/loader', () => ({ runtime_config: () => mocks.config }))
vi.mock('@server/lib/log', () => ({ error_fields: vi.fn(), log_error: vi.fn() }))
vi.mock('@alicloud/dypnsapi20170525', () => ({
  default: class {
    sendSmsVerifyCode = mocks.send
    checkSmsVerifyCode = mocks.check
  },
  SendSmsVerifyCodeRequest: class {
    constructor(input: object) {
      Object.assign(this, input)
    }
  },
  CheckSmsVerifyCodeRequest: class {
    constructor(input: object) {
      Object.assign(this, input)
    }
  },
}))

const { check_otp_sms, send_otp_sms } = await import('./sms')
const send_input = { phone: '19000000000', out_id: 'test-request' }
const check_input = { phone: '19000000000', code: '123456' }

beforeEach(() => {
  vi.clearAllMocks()
  mocks.config.app.otp.debug = false
  mocks.send.mockResolvedValue({ body: { success: true, code: 'OK' } })
  mocks.check.mockResolvedValue({ body: { success: true, code: 'OK', model: { verifyResult: 'PASS' } } })
})

afterEach(() => vi.unstubAllEnvs())

describe('otp debug environment boundary', () => {
  it('skips sending and checking only in development with debug enabled', async () => {
    vi.stubEnv('NODE_ENV', 'development')
    mocks.config.app.otp.debug = true

    await send_otp_sms(send_input)
    await check_otp_sms(check_input)

    expect(mocks.send).not.toHaveBeenCalled()
    expect(mocks.check).not.toHaveBeenCalled()
  })

  it.each(['development', 'production', 'test', 'staging', ''])('calls the provider with debug disabled in %s', async (NODE_ENV) => {
    vi.stubEnv('NODE_ENV', NODE_ENV)

    await send_otp_sms(send_input)
    await check_otp_sms(check_input)

    expect(mocks.send).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ phoneNumber: send_input.phone, returnVerifyCode: false }))
    expect(mocks.check).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ phoneNumber: check_input.phone, verifyCode: check_input.code }))
  })

  it.each(['production', 'test', 'staging', ''])('cannot bypass an invalid OTP using forged debug config in %s', async (NODE_ENV) => {
    vi.stubEnv('NODE_ENV', NODE_ENV)
    mocks.config.app.otp.debug = true
    mocks.check.mockResolvedValue({ body: { success: true, code: 'OK', model: { verifyResult: 'FAIL' } } })

    await send_otp_sms(send_input)
    await expect(check_otp_sms(check_input)).rejects.toMatchObject({ statusCode: 400 })

    expect(mocks.send).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ returnVerifyCode: false }))
    expect(mocks.check).toHaveBeenCalledOnce()
  })

  it('refuses when the verification provider is unavailable', async () => {
    mocks.check.mockRejectedValue(new Error('provider unavailable'))

    await expect(check_otp_sms(check_input)).rejects.toMatchObject({ statusCode: 400 })
    expect(mocks.check).toHaveBeenCalledOnce()
  })
})
