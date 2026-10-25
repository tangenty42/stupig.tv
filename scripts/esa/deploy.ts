import type { Api } from './api'
import type { PublishConfig } from './config'
import { publish_variables, PublishError } from './config'

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && ! Array.isArray(value) ? value as Record<string, unknown> : {}
}

async function pages(api: Api, action: 'ListRoutineRoutes' | 'ListRoutineCodeVersions' | 'ListRoutineEnvironmentVariables', fields: Record<string, string>, field: string) {
  const result: Record<string, unknown>[] = []
  for (let page = 1; page <= 100; page ++) {
    const data = await api(action, { ... fields, PageNumber: String(page), PageSize: '20' })
    const items = data[field]
    const rows = Array.isArray(items)
      ? items.map(record)
      : field === 'EnvironmentVariables' && items && typeof items === 'object'
        ? Object.entries(items).map(([Key, value]) => ({ ... record(value), Key }))
        : undefined
    if (! rows || ! Number.isSafeInteger(data.TotalCount) || Number(data.TotalCount) < 0)
      throw new PublishError(`Invalid paginated response from ${action}`)
    result.push(... rows)
    if (result.length >= Number(data.TotalCount))
      return result
    if (! rows.length)
      break
  }
  throw new PublishError(`Incomplete pagination from ${action}`)
}

export function deployment_versions(detail: Record<string, unknown>, environment: string) {
  const env = Array.isArray(detail.Envs) ? detail.Envs.map(record).find(item => item.Env === environment) : undefined
  const versions = record(env?.CodeDeploy).CodeVersions
  if (! Array.isArray(versions))
    return []
  return versions.map(record).map(item => ({ CodeVersion: String(item.CodeVersion), Percentage: Number(item.Percentage) }))
}

export async function preflight(config: PublishConfig, api: Api) {
  const detail = await api('GetRoutine', { Name: config.name })
  const routes = await pages(api, 'ListRoutineRoutes', { RoutineName: config.name }, 'Configs')
  const host = new URL(config.deliveryUrl).hostname
  // Accept only the full Content scope. Extra auth_key/method predicates would bypass authorization.
  // Preserve quoted literals: spaces/parentheses inside a host or path change scope.
  const compact = (rule: string) => rule.replace(/"(?:[^"\\]|\\.)*"|[()\s]+/g, token => token.startsWith('"') ? token : '')
  const expected = [
    `http.host eq "${host}" and starts_with(http.request.uri, "/content/")`,
    `http.host eq "${host}" and starts_with(http.request.full_uri, "${new URL(config.deliveryUrl).origin}/content/")`,
  ].map(compact)
  const enabled = routes.filter(route => route.RouteEnable === 'on')
  if (! enabled.length || enabled.some(route => String(route.SiteId) !== config.siteId || route.RoutineName !== config.name
    || route.Bypass !== 'on' || route.Fallback !== 'off' || route.Mode !== 'custom'
    || typeof route.Rule !== 'string' || ! expected.includes(compact(route.Rule)))) {
    throw new PublishError('ESA route mismatch: require the configured site/host, full /content/ scope, enabled, bypass=on, fallback=off; see --plan')
  }
  const variables = await read_variables(config, api)
  return { previousVersions: deployment_versions(detail, config.environment), variables }
}

async function read_variables(config: PublishConfig, api: Api) {
  const rows = await pages(api, 'ListRoutineEnvironmentVariables', { Name: config.name, Env: config.environment }, 'EnvironmentVariables')
  return Object.fromEntries(rows.map(row => [String(row.Key), { Type: row.Type, Value: row.Value }]))
}

export function variable_status(config: PublishConfig, variables: Awaited<ReturnType<typeof read_variables>>) {
  return Object.entries(publish_variables(config)).map(([name, expected]) => ({
    name,
    status: ! variables[name]
      ? 'missing'
      : variables[name].Type !== expected.Type
        ? 'type-mismatch'
        : expected.Type === 'secret_text'
          ? 'secret-present-value-unverifiable'
          : variables[name].Value === expected.Value ? 'matches' : 'value-mismatch',
  }))
}

export interface PublishDependencies {
  api: Api
  commit: (config: PublishConfig, source: Buffer, description: string) => Promise<string>
  sleep: (ms: number) => Promise<void>
  now: () => number
  checkpoint: (update: Record<string, unknown>) => Promise<void>
}

export async function publish(config: PublishConfig, source: Buffer, description: string, deps: PublishDependencies) {
  const { api, checkpoint } = deps
  const initial = await preflight(config, api)
  await checkpoint({ stage: 'preflight-passed', previousVersions: initial.previousVersions })
  const variables = publish_variables(config)
  await checkpoint({ stage: 'syncing-variables' })
  const updated = await api('SetRoutineEnvironmentVariables', {
    Name: config.name, Env: config.environment, EnvironmentVariables: JSON.stringify(variables),
  })
  const set_keys = updated.SetKeys
  if (! Array.isArray(set_keys) || Object.keys(variables).some(key => ! set_keys.includes(key)))
    throw new PublishError('ESA did not acknowledge all variables; no code version was published')
  const status = variable_status(config, await read_variables(config, api))
  if (status.some(item => ! ['matches', 'secret-present-value-unverifiable'].includes(item.status)))
    throw new PublishError('ESA variable readback mismatch; no code version was published')
  await checkpoint({ stage: 'creating-version' })
  const version = await deps.commit(config, source, description)
  if (! /^\d+$/.test(version))
    throw new PublishError('Invalid ESA code version')
  await checkpoint({ stage: 'waiting-version', version })
  const deadline = deps.now() + config.readinessTimeoutMs
  for (;;) {
    const info = await api('GetRoutineCodeVersionInfo', { Name: config.name, CodeVersion: version })
    const state = String(info.Status).toLowerCase()
    if (state === 'available')
      break
    if (! ['init', 'pending', 'building', 'uploading', 'initializing'].includes(state) || deps.now() >= deadline)
      throw new PublishError('New ESA code version is not ready; deployment stopped')
    await deps.sleep(2000)
  }
  // SearchKeyWord does not reliably search CodeDescription. Enumerate and verify
  // the exact commit result instead of treating an empty search as missing code.
  const versions = await pages(api, 'ListRoutineCodeVersions', { Name: config.name }, 'CodeVersions')
  const selected = versions.find(item => item.CodeVersion === version)
  if (! selected || selected.DeployEnv !== config.environment || selected.CodeDescription !== description)
    throw new PublishError('New version environment/description mismatch; deployment stopped')
  // Catch routes/environment drift while uploading before changing the live code.
  const latest = await preflight(config, api)
  if (JSON.stringify(latest.previousVersions) !== JSON.stringify(initial.previousVersions)
    || variable_status(config, latest.variables).some(item => ! ['matches', 'secret-present-value-unverifiable'].includes(item.status))) {
    throw new PublishError('ESA changed during publication; stopped before deployment')
  }
  await checkpoint({ stage: 'deploying', version })
  let acknowledgement_lost = false
  try {
    await api('CreateRoutineCodeDeployment', {
      Name: config.name, Env: config.environment, Strategy: 'percentage',
      CodeVersions: JSON.stringify([{ CodeVersion: version, Percentage: 100 }]),
    })
  }
  catch {
    // Do not repeat the mutation. Only reconcile the exact requested version.
    acknowledgement_lost = true
  }
  const deployment_deadline = deps.now() + config.readinessTimeoutMs
  for (;;) {
    const current = deployment_versions(await api('GetRoutine', { Name: config.name }), config.environment)
    if (current.length === 1 && current[0]?.CodeVersion === version && current[0].Percentage === 100)
      break
    if (deps.now() >= deployment_deadline)
      throw new PublishError('Deployment could not be verified; inspect ESA before retrying (no automatic rollback)')
    await deps.sleep(2000)
  }
  await checkpoint({ stage: 'deployed', version, acknowledgementLost: acknowledgement_lost })
  return version
}
