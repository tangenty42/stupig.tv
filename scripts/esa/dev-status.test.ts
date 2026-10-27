import type { Api } from './api'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { create_commit_description } from './commit'
import { load_publish_config, publish_variables } from './config'
import { inspect_dev_esa, local_dev_receipt } from './dev-status'

const config = load_publish_config({
  NODE_ENV: 'development', ALIYUN_ESA_SITE_ID: '123', ALIYUN_ESA_AUTH_KEY: 'private-value'.repeat(3),
  ALIYUN_ESA_PUBLISH_ACCESS_KEY_ID: 'test-id', ALIYUN_ESA_PUBLISH_ACCESS_KEY_SECRET: 'test-secret',
})
const source = Buffer.from('export default {}\n')
const run = '2026-10-27T00-00-00-000Z-c0ad047b-fbfe-4725-b295-d43012181152'

function harness() {
  const variables = publish_variables(config)
  const state = {
    versions: [{ CodeVersion: '100', Percentage: 100 }],
    description: create_commit_description('dev', run, source),
    variables,
    remote: source.toString('base64'),
    source_readable: true,
  }
  const api = vi.fn<Api>(async (action) => {
    switch (action) {
      case 'GetRoutine':
        return { Envs: [{ Env: 'production', CodeDeploy: { CodeVersions: state.versions } }] }
      case 'ListRoutineRoutes':
        return { TotalCount: 1, Configs: [{ SiteId: 123, RoutineName: config.name, RouteEnable: 'on', Bypass: 'on', Fallback: 'off', Mode: 'custom',
          Rule: `(http.host eq "${new URL(config.deliveryUrl).hostname}" and starts_with(http.request.uri, "/content/"))` }] }
      case 'ListRoutineEnvironmentVariables':
        return { TotalCount: 3, EnvironmentVariables: state.variables }
      case 'ListRoutineCodeVersions':
        return { TotalCount: 1, CodeVersions: [{ CodeVersion: '100', CodeDescription: state.description }] }
      case 'GetRoutineCodeVersion':
        if (! state.source_readable)
          throw new Error('raw secret')
        return { RoutineCode: state.remote }
      default:
        throw new Error(`Unexpected write: ${action}`)
    }
  })
  return { api, state }
}

describe('development ESA notice', () => {
  it('uses the active version fingerprint and only read-only APIs', async () => {
    const { api, state } = harness()
    state.variables.ALIYUN_ESA_AUTH_KEY.Value = 'masked-cloud-secret'
    expect(await inspect_dev_esa(config, api, source)).toEqual({ source: 'matches', configuration: 'matches', evidence: 'metadata' })
    expect(api.mock.calls.map(([action]) => action)).toEqual(['GetRoutine', 'ListRoutineRoutes', 'ListRoutineEnvironmentVariables', 'ListRoutineCodeVersions', 'GetRoutine'])
    expect(await inspect_dev_esa(config, api, Buffer.from('changed'))).toEqual({ source: 'differs', configuration: 'matches', evidence: 'metadata' })
  })

  it('reports non-secret configuration drift without exposing values', async () => {
    const { api, state } = harness()
    state.variables.CONTENT_AUTH_URL.Value = 'https://other.example.test/api/content/authorize'
    const result = await inspect_dev_esa(config, api, source)
    expect(result).toEqual({ source: 'matches', configuration: 'differs', evidence: 'metadata' })
    expect(JSON.stringify(result)).not.toContain('other.example.test')
  })

  it('reads older versions when permitted and otherwise reports uncertainty', async () => {
    const { api, state } = harness()
    state.description = 'legacy-version'
    expect(await inspect_dev_esa(config, api, source)).toEqual({ source: 'matches', configuration: 'matches', evidence: 'online' })
    state.remote = Buffer.from('changed').toString('base64')
    expect(await inspect_dev_esa(config, api, source)).toEqual({ source: 'differs', configuration: 'matches', evidence: 'online' })
    state.source_readable = false
    expect(await inspect_dev_esa(config, api, source, async () => null)).toEqual({ source: 'unverifiable', configuration: 'matches', evidence: null })
  })

  it('uses only a completed receipt bound to the exact active dev version and target', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dev-esa-notice-'))
    try {
      const digest = createHash('sha256').update(source).digest('hex')
      const receipt = { application: 'dev', function: config.name, environment: config.environment, siteId: config.siteId, stage: 'deployed', version: '100', sha256: digest }
      await writeFile(join(directory, 'dev-test.json'), JSON.stringify(receipt))
      expect(await local_dev_receipt(config, '100', directory)).toBe(digest)
      expect(await local_dev_receipt(config, '200', directory)).toBeNull()
      expect(await local_dev_receipt({ ... config, siteId: '999' }, '100', directory)).toBeNull()
      const { api, state } = harness()
      state.description = 'legacy-version'
      state.source_readable = false
      const lookup = (target: typeof config, version: string) => local_dev_receipt(target, version, directory)
      expect(await inspect_dev_esa(config, api, source, lookup)).toEqual({ source: 'matches', configuration: 'matches', evidence: 'receipt' })
      expect(await inspect_dev_esa(config, api, Buffer.from('changed'), lookup)).toEqual({ source: 'differs', configuration: 'matches', evidence: 'receipt' })
      await writeFile(join(directory, 'dev-conflict.json'), JSON.stringify({ ... receipt, sha256: 'a'.repeat(64) }))
      expect(await local_dev_receipt(config, '100', directory)).toBeNull()
    }
    finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('does not claim a match for a split deployment or a production target', async () => {
    const { api, state } = harness()
    state.versions = [{ CodeVersion: '100', Percentage: 50 }, { CodeVersion: '200', Percentage: 50 }]
    expect(await inspect_dev_esa(config, api, source)).toEqual({ source: 'unverifiable', configuration: 'matches', evidence: null })
    await expect(inspect_dev_esa({ ... config, appEnvironment: 'prod' }, api, source)).rejects.toThrow('development target')
  })

  it('does not claim a match if another deployment replaces the version during the check', async () => {
    const { api, state } = harness()
    const racing = vi.fn<Api>(async (action, fields) => {
      const result = await api(action, fields)
      if (action === 'ListRoutineCodeVersions')
        state.versions = [{ CodeVersion: '200', Percentage: 100 }]
      return result
    })
    expect(await inspect_dev_esa(config, racing, source)).toEqual({ source: 'unverifiable', configuration: 'matches', evidence: null })
  })
})
