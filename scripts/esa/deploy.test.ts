import type { Api } from './api'
import type { PublishDependencies } from './deploy'
import { describe, expect, it, vi } from 'vitest'
import { load_publish_config, publish_variables } from './config'
import { preflight, publish, variable_status } from './deploy'

const config = load_publish_config({
  NODE_ENV: 'development', ALIYUN_ESA_SITE_ID: '123', ALIYUN_ESA_AUTH_KEY: 'private-value'.repeat(3),
  ALIYUN_ESA_PUBLISH_ACCESS_KEY_ID: 'test-id', ALIYUN_ESA_PUBLISH_ACCESS_KEY_SECRET: 'test-secret',
})
const source = Buffer.from('export default {}')
const description = 'test-run-description'

function harness() {
  let clock = 0
  const state = {
    routes: [{ SiteId: 123, RoutineName: config.name, RouteEnable: 'on', Bypass: 'on', Fallback: 'off', Mode: 'custom',
      Rule: `(http.host eq "${new URL(config.deliveryUrl).hostname}" and starts_with(http.request.uri, "/content/"))` }],
    variables: {} as Record<string, { Type: string, Value: string }>,
    current: [{ CodeVersion: '100', Percentage: 100 }],
    codeVersion: '200', codeStatus: 'Available', deployEnv: 'production', codeDescription: description,
    setPartial: false, deploymentUnknown: false, deploymentApplied: true, concurrent: false,
  }
  const api = vi.fn<Api>(async (action, fields) => {
    expect(fields.Name ?? fields.RoutineName).toBe(config.name)
    switch (action) {
      case 'GetRoutine':
        return { Envs: [{ Env: 'production', CodeDeploy: { CodeVersions: state.current } }] }
      case 'ListRoutineRoutes':
        return { Configs: state.routes, TotalCount: state.routes.length }
      case 'ListRoutineEnvironmentVariables':
        return { EnvironmentVariables: state.variables, TotalCount: Object.keys(state.variables).length }
      case 'SetRoutineEnvironmentVariables':
        expect(fields.Env).toBe('production')
        state.variables = JSON.parse(fields.EnvironmentVariables!)
        return { SetKeys: state.setPartial ? ['CONTENT_AUTH_URL'] : Object.keys(state.variables) }
      case 'GetRoutineCodeVersionInfo':
        return { CodeVersion: '200', Status: state.codeStatus }
      case 'ListRoutineCodeVersions':
        expect(fields).not.toHaveProperty('SearchKeyWord')
        return { CodeVersions: [{ CodeVersion: state.codeVersion, DeployEnv: state.deployEnv, CodeDescription: state.codeDescription }], TotalCount: 1 }
      case 'CreateRoutineCodeDeployment':
        expect(fields).toMatchObject({ Env: 'production', Strategy: 'percentage' })
        if (state.deploymentApplied)
          state.current = JSON.parse(fields.CodeVersions!)
        if (state.deploymentUnknown)
          throw new Error('raw SDK secret must not escape')
        return { DeploymentId: '300' }
      default:
        throw new Error(`Unexpected API action: ${action}`)
    }
  })
  const deps: PublishDependencies = {
    api,
    commit: vi.fn(async (_config, snapshot, version_description) => {
      expect(snapshot).toEqual(source)
      expect(version_description).toBe(description)
      expect(state.variables).toEqual(publish_variables(config))
      if (state.concurrent)
        state.current = [{ CodeVersion: '999', Percentage: 100 }]
      return '200'
    }),
    now: () => clock,
    sleep: async (ms) => { clock += ms },
    checkpoint: vi.fn(async () => {}),
  }
  const writes = () => api.mock.calls.filter(([action]) => ['SetRoutineEnvironmentVariables', 'CreateRoutineCodeDeployment'].includes(action))
  return { state, deps, api, writes }
}

describe('eSA publication orchestration', () => {
  it('checks without writes and reports drift without exposing variable values', async () => {
    const { deps, state, writes } = harness()
    state.variables = { ALIYUN_ESA_AUTH_KEY: { Type: 'secret_text', Value: 'masked-cloud-secret' } }
    const check = await preflight(config, deps.api)
    const status = variable_status(config, check.variables)
    expect(status).toEqual([
      { name: 'ALIYUN_ESA_AUTH_KEY', status: 'secret-present-value-unverifiable' },
      { name: 'CONTENT_AUTH_URL', status: 'missing' },
      { name: 'CONTENT_AUTH_TIMEOUT_MS', status: 'missing' },
    ])
    expect(JSON.stringify(status)).not.toContain('masked-cloud-secret')
    expect(writes()).toEqual([])
  })

  it('rejects unexpected version metadata before it reaches a receipt', async () => {
    const { deps, state } = harness()
    state.current = [{ CodeVersion: config.accessKeySecret, Percentage: 100 }]
    await expect(publish(config, source, description, deps)).rejects.toThrow('Invalid ESA deployment version metadata')
    expect(JSON.stringify(vi.mocked(deps.checkpoint).mock.calls)).not.toContain(config.accessKeySecret)
  })

  it('syncs encrypted/plain variables before commit and deploys only the returned version', async () => {
    const { deps, api } = harness()
    expect(await publish(config, source, description, deps)).toBe('200')
    expect(api.mock.calls.map(([action]) => action)).toEqual([
      'GetRoutine', 'ListRoutineRoutes', 'ListRoutineEnvironmentVariables', 'SetRoutineEnvironmentVariables', 'ListRoutineEnvironmentVariables',
      'GetRoutineCodeVersionInfo', 'ListRoutineCodeVersions', 'GetRoutine', 'ListRoutineRoutes', 'ListRoutineEnvironmentVariables',
      'CreateRoutineCodeDeployment', 'GetRoutine',
    ])
    const deployment = api.mock.calls.find(([action]) => action === 'CreateRoutineCodeDeployment')![1]
    expect(JSON.parse(deployment.CodeVersions!)).toEqual([{ CodeVersion: '200', Percentage: 100 }])
    expect(deps.checkpoint).toHaveBeenLastCalledWith({ stage: 'deployed', version: '200', acknowledgementLost: false })
    const receipt_updates = JSON.stringify(vi.mocked(deps.checkpoint).mock.calls)
    for (const secret of [config.authKey, config.accessKeyId, config.accessKeySecret])
      expect(receipt_updates).not.toContain(secret)
  })

  it.each([
    { Bypass: 'off' }, { Fallback: 'on' }, { RouteEnable: 'off' }, { SiteId: 999 },
    { Rule: '(http.host eq "another.example.test")' },
    { Rule: `(http.host eq "${new URL(config.deliveryUrl).hostname}" and starts_with(http.request.uri, "/con tent/"))` },
    { Rule: `(http.host eq "${new URL(config.deliveryUrl).hostname}" and starts_with(http.request.uri, "/content()/"))` },
    { Rule: `(http.host eq "${new URL(config.deliveryUrl).hostname}" and starts_with(http.request.uri, "/content/") and http.request.full_uri contains "auth_key=")` },
  ])('rejects unsafe route %j before writes', async (patch) => {
    const { deps, state, writes } = harness()
    Object.assign(state.routes[0]!, patch)
    await expect(publish(config, source, description, deps)).rejects.toThrow('route mismatch')
    expect(writes()).toEqual([])
    expect(deps.commit).not.toHaveBeenCalled()
  })

  it('accepts the equivalent full_uri scope without accepting another host', async () => {
    const { deps, state } = harness()
    state.routes[0]!.Rule = `(http.host eq "${new URL(config.deliveryUrl).hostname}") and starts_with(http.request.full_uri, "${config.deliveryUrl}/content/")`
    await expect(preflight(config, deps.api)).resolves.toBeDefined()
  })

  it('waits through the official CLI Init state before deploying the exact new version', async () => {
    const { deps, state, api } = harness()
    state.codeStatus = 'Init'
    const sleep = deps.sleep
    deps.sleep = vi.fn(async (ms) => {
      await sleep(ms)
      state.codeStatus = 'Available'
    })
    await expect(publish(config, source, description, deps)).resolves.toBe('200')
    expect(deps.sleep).toHaveBeenCalledWith(2000)
    expect(api.mock.calls.filter(([action]) => action === 'GetRoutineCodeVersionInfo')).toHaveLength(2)
    expect(api.mock.calls.filter(([action]) => action === 'CreateRoutineCodeDeployment')).toHaveLength(1)
  })

  it('stops on an Init timeout without deploying the unfinished version', async () => {
    const { deps, state, writes } = harness()
    state.codeStatus = 'Init'
    const sleep = vi.fn(deps.sleep)
    deps.sleep = sleep
    await expect(publish({ ... config, readinessTimeoutMs: 1000 }, source, description, deps)).rejects.toThrow('not ready')
    expect(sleep).toHaveBeenCalledOnce()
    expect(writes().map(([action]) => action)).toEqual(['SetRoutineEnvironmentVariables'])
  })

  it('finds the committed version on later pages and verifies its description and environment', async () => {
    const { deps, api } = harness()
    deps.api = vi.fn(async (action, fields) => action === 'ListRoutineCodeVersions'
      ? { CodeVersions: fields.PageNumber === '1'
          ? [{ CodeVersion: '999', CodeDescription: description, DeployEnv: 'production' }]
          : [{ CodeVersion: '200', CodeDescription: description, DeployEnv: 'production' }], TotalCount: 2 }
      : api(action, fields))
    await expect(publish(config, source, description, deps)).resolves.toBe('200')
    expect(deps.api).toHaveBeenCalledWith('ListRoutineCodeVersions', { Name: config.name, PageNumber: '2', PageSize: '20' })
    expect(api).toHaveBeenCalledWith('CreateRoutineCodeDeployment', expect.objectContaining({ CodeVersions: JSON.stringify([{ CodeVersion: '200', Percentage: 100 }]) }))
  })

  it('does not commit when only some variable keys were acknowledged', async () => {
    const { deps, state, writes } = harness()
    state.setPartial = true
    await expect(publish(config, source, description, deps)).rejects.toThrow('acknowledge all variables')
    expect(deps.commit).not.toHaveBeenCalled()
    expect(writes()).toHaveLength(1)
  })

  it.each(['commit-failure', 'wrong-environment', 'wrong-description', 'wrong-version', 'failed-build', 'concurrent-deploy'])('does not deploy after %s', async (failure) => {
    const { deps, state, writes } = harness()
    if (failure === 'commit-failure')
      vi.mocked(deps.commit).mockRejectedValue(new Error('commit failed'))
    if (failure === 'wrong-environment')
      state.deployEnv = 'staging'
    if (failure === 'wrong-description')
      state.codeDescription = 'another-run'
    if (failure === 'wrong-version')
      state.codeVersion = '999'
    if (failure === 'failed-build')
      state.codeStatus = 'Failed'
    if (failure === 'concurrent-deploy')
      state.concurrent = true
    await expect(publish(config, source, description, deps)).rejects.toThrow()
    expect(writes().map(([action]) => action)).toEqual(['SetRoutineEnvironmentVariables'])
  })

  it('reconciles a lost deployment acknowledgement without repeating the mutation', async () => {
    const { deps, state, writes } = harness()
    state.deploymentUnknown = true
    expect(await publish(config, source, description, deps)).toBe('200')
    expect(writes().filter(([action]) => action === 'CreateRoutineCodeDeployment')).toHaveLength(1)
    expect(deps.checkpoint).toHaveBeenLastCalledWith({ stage: 'deployed', version: '200', acknowledgementLost: true })
  })

  it('fails an unverifiable deployment without automatic rollback or repeat publication', async () => {
    const { deps, state, writes } = harness()
    state.deploymentApplied = false
    state.deploymentUnknown = true
    await expect(publish({ ... config, readinessTimeoutMs: 1000 }, source, description, deps)).rejects.toThrow('could not be verified')
    expect(writes().filter(([action]) => action === 'CreateRoutineCodeDeployment')).toHaveLength(1)
  })

  it('validates all route pages, including a dangerous second page', async () => {
    const { deps, state } = harness()
    const original = deps.api
    deps.api = vi.fn(async (action, fields) => action === 'ListRoutineRoutes'
      ? { Configs: fields.PageNumber === '1' ? state.routes : [{ ... state.routes[0], Fallback: 'on' }], TotalCount: 2 }
      : original(action, fields))
    await expect(preflight(config, deps.api)).rejects.toThrow('route mismatch')
    expect(deps.api).toHaveBeenCalledWith('ListRoutineRoutes', expect.objectContaining({ PageNumber: '2' }))
  })
})
