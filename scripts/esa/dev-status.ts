import type { Api } from './api'
import type { PublishConfig } from './config'
import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { source_fingerprint } from './commit'
import { deployment_versions, preflight, variable_status } from './deploy'

export interface DevEsaStatus {
  source: 'matches' | 'differs' | 'unverifiable'
  configuration: 'matches' | 'differs'
  evidence: 'metadata' | 'online' | 'receipt' | null
}

/** Only a completed receipt for this exact active version can identify its source. */
export async function local_dev_receipt(config: PublishConfig, version: string, directory = resolve('.data/esa-deploy')) {
  try {
    const entries = await readdir(directory, { withFileTypes: true })
    const hashes = new Set<string>()
    for (const entry of entries) {
      if (! entry.isFile() || ! /^dev-[\w-]+\.json$/.test(entry.name))
        continue
      try {
        const receipt = JSON.parse(await readFile(resolve(directory, entry.name), 'utf8'))
        if (receipt.application === 'dev' && receipt.function === config.name && receipt.environment === config.environment
          && String(receipt.siteId) === config.siteId && receipt.stage === 'deployed' && receipt.failed !== true
          && String(receipt.version) === version && typeof receipt.sha256 === 'string' && /^[a-f\d]{64}$/.test(receipt.sha256)) {
          hashes.add(receipt.sha256)
        }
      }
      catch { /* Ignore incomplete or unrelated local receipts. */ }
    }
    return hashes.size === 1 ? [... hashes][0]! : null
  }
  catch { return null }
}

/** Read only: compare the active dev version and the non-secret variables. */
export async function inspect_dev_esa(config: PublishConfig, api: Api, source: Buffer, receipt = local_dev_receipt): Promise<DevEsaStatus> {
  if (config.appEnvironment !== 'dev')
    throw new Error('Dev ESA notice only supports the development target')
  const checked = await preflight(config, api)
  const configuration = variable_status(config, checked.variables).some(item => ! ['matches', 'secret-present-value-unverifiable'].includes(item.status))
    ? 'differs'
    : 'matches'
  const versions = checked.previousVersions
  if (versions.length !== 1 || versions[0]?.Percentage !== 100 || ! /^\d+$/.test(versions[0].CodeVersion))
    return { source: 'unverifiable', configuration, evidence: null }
  const active = versions[0].CodeVersion
  const checked_version = async (result: DevEsaStatus): Promise<DevEsaStatus> => {
    const current = deployment_versions(await api('GetRoutine', { Name: config.name }), config.environment)
    return current.length === 1 && current[0]?.CodeVersion === active && current[0].Percentage === 100
      ? result
      : { source: 'unverifiable', configuration, evidence: null }
  }
  for (let page = 1; page <= 100; page ++) {
    const result = await api('ListRoutineCodeVersions', { Name: config.name, PageNumber: String(page), PageSize: '20' })
    const rows = result.CodeVersions
    if (! Array.isArray(rows) || ! Number.isSafeInteger(result.TotalCount) || Number(result.TotalCount) < 0)
      throw new Error('Invalid ESA version listing')
    const match = rows.find(item => item && typeof item === 'object' && item.CodeVersion === active)
    if (match) {
      const description = typeof match.CodeDescription === 'string' ? match.CodeDescription : ''
      const fingerprint = /^dev-([\w-]{22})-[a-f\d-]{36}$/.exec(description)?.[1]
      if (fingerprint)
        return checked_version({ source: fingerprint === source_fingerprint(source) ? 'matches' : 'differs', configuration, evidence: 'metadata' })
      break
    }
    if (rows.length === 0 || page * 20 >= Number(result.TotalCount))
      break
  }
  // Older releases lack fingerprints. Some identities can read the exact
  // source; the standard publisher may lack this optional read permission.
  try {
    const result = await api('GetRoutineCodeVersion', { Name: config.name, CodeVersion: active })
    if (typeof result.RoutineCode === 'string' && /^[\w+/]+={0,2}$/.test(result.RoutineCode)) {
      const remote = Buffer.from(result.RoutineCode, 'base64')
      if (remote.length && remote.toString('base64') === result.RoutineCode)
        return checked_version({ source: source_fingerprint(remote) === source_fingerprint(source) ? 'matches' : 'differs', configuration, evidence: 'online' })
    }
  }
  catch { /* Report an unverifiable legacy version without SDK diagnostics. */ }
  const digest = await receipt(config, active)
  if (digest) {
    const local = createHash('sha256').update(source).digest('hex')
    return checked_version({ source: digest === local ? 'matches' : 'differs', configuration, evidence: 'receipt' })
  }
  return { source: 'unverifiable', configuration, evidence: null }
}
