import { beforeEach, describe, expect, it, vi } from 'vitest'
import { create_api } from './api'
import { load_publish_config, publish_variables } from './config'

const { callApi } = vi.hoisted(() => ({ callApi: vi.fn() }))
vi.mock('@alicloud/openapi-client', () => ({
  default: class { callApi = callApi },
  Config: class { constructor(values: unknown) { Object.assign(this, values) } },
  Params: class { constructor(values: unknown) { Object.assign(this, values) } },
  OpenApiRequest: class { constructor(values: unknown) { Object.assign(this, values) } },
}))
vi.mock('@alicloud/tea-util', () => ({
  RuntimeOptions: class { constructor(values: unknown) { Object.assign(this, values) } },
}))

const config = load_publish_config({ NODE_ENV: 'development', ALIYUN_ESA_AUTH_KEY: 'secret-do-not-echo' })
beforeEach(() => {
  callApi.mockReset().mockResolvedValue({ statusCode: 200, body: { SetKeys: ['ALIYUN_ESA_AUTH_KEY'] } })
})

describe('eSA API transport', () => {
  it('puts secret variables in HTTPS POST form body and disables retries', async () => {
    const api = create_api(config)
    const fields = { Name: config.name, Env: 'production', EnvironmentVariables: JSON.stringify(publish_variables(config)) }
    await api('SetRoutineEnvironmentVariables', fields)
    expect(callApi).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'SetRoutineEnvironmentVariables', protocol: 'HTTPS', method: 'POST', reqBodyType: 'formData' }),
      { body: fields }, expect.objectContaining({ autoretry: false }),
    )
    await api('ListRoutineRoutes', { RoutineName: config.name })
    expect(callApi.mock.lastCall?.[1]).toEqual({ query: { RoutineName: config.name } })
    await api('GetRoutineCodeVersion', { Name: config.name, CodeVersion: '100' })
    expect(callApi.mock.lastCall?.[1]).toEqual({ body: { Name: config.name, CodeVersion: '100' } })
  })

  it('never exposes SDK diagnostics containing the request or secret', async () => {
    callApi.mockRejectedValue(new Error(`request ${config.authKey}`))
    const error = await create_api(config)('SetRoutineEnvironmentVariables', {}).catch(error => error as Error)
    expect(error.message).toContain('SetRoutineEnvironmentVariables failed')
    expect(error.message).not.toContain(config.authKey)
    expect(callApi).toHaveBeenCalledTimes(1)
  })
})
