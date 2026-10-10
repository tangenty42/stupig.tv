import { createHmac } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  config: {
    aliyun: {
      captcha: { appId: 'app-id-123', appKey: 'app-key-456' },
    },
  },
}))

vi.mock('@config/loader', () => ({ runtime_config: () => mocks.config }))

const { verify_captcha } = await import('@server/lib/captcha')

const valid_params = {
  lot_number: 'lot-1',
  captcha_output: 'output-1',
  pass_token: 'pass-1',
  gen_time: '1700000000',
}

const fetch_mock = vi.fn()

function respond_with(body: unknown, init: { ok?: boolean, status?: number, throws?: boolean } = {}) {
  fetch_mock.mockImplementation(async () => {
    if (init.throws) {
      throw new Error('socket hang up')
    }
    return {
      ok: init.ok ?? true,
      status: init.status ?? 200,
      json: async () => body,
    }
  })
}

beforeEach(() => {
  fetch_mock.mockReset()
  respond_with({ result: 'success', reason: '' })
  vi.stubGlobal('fetch', fetch_mock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('verify_captcha', () => {
  it('skips validation entirely when the captcha is not configured', async () => {
    const app_id = mocks.config.aliyun.captcha.appId
    mocks.config.aliyun.captcha.appId = ''

    try {
      await expect(verify_captcha(undefined)).resolves.toBeUndefined()
    }
    finally {
      mocks.config.aliyun.captcha.appId = app_id
    }

    expect(fetch_mock).not.toHaveBeenCalled()
  })

  it.each(Object.keys(valid_params))('rejects a submission missing %s', async (missing) => {
    const params = { ... valid_params, [missing]: undefined }

    await expect(verify_captcha(params)).rejects.toMatchObject({ statusCode: 400, message: 'Wow~这招厉害！' })
    expect(fetch_mock).not.toHaveBeenCalled()
  })

  it('rejects a submission with no captcha payload at all', async () => {
    await expect(verify_captcha(undefined)).rejects.toMatchObject({ statusCode: 400 })
    expect(fetch_mock).not.toHaveBeenCalled()
  })

  it('posts the payload with an hmac sign token derived from the lot number', async () => {
    await expect(verify_captcha(valid_params)).resolves.toBeUndefined()

    const [url, init] = fetch_mock.mock.calls[0] as [string, { method: string, headers: Record<string, string>, body: string }]

    expect(url).toBe(`https://captcha.alicaptcha.com/validate?captcha_id=${encodeURIComponent(mocks.config.aliyun.captcha.appId)}`)
    expect(init.method).toBe('POST')
    expect(init.headers['Content-Type']).toBe('application/x-www-form-urlencoded')

    const body = new URLSearchParams(init.body)
    expect(Object.fromEntries(body)).toEqual({
      ... valid_params,
      sign_token: createHmac('sha256', mocks.config.aliyun.captcha.appKey).update(valid_params.lot_number).digest('hex'),
    })
  })

  it('rejects a submission the vendor marks as failed', async () => {
    respond_with({ result: 'failed', reason: 'bad token' })

    await expect(verify_captcha(valid_params)).rejects.toMatchObject({ statusCode: 403, message: '汝果真人机乎？！' })
  })

  it('fails open when the captcha service is unreachable', async () => {
    respond_with(null, { throws: true })

    await expect(verify_captcha(valid_params)).resolves.toBeUndefined()
  })

  it('fails open on a non-2xx response', async () => {
    respond_with(null, { ok: false, status: 502 })

    await expect(verify_captcha(valid_params)).resolves.toBeUndefined()
  })

  it('fails open when the response body is not JSON', async () => {
    fetch_mock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('Unexpected token')
      },
    })

    await expect(verify_captcha(valid_params)).resolves.toBeUndefined()
  })
})
