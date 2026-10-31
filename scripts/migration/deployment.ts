import type { MigrationFile } from './catalog'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { legacy_baseline_through, runtime_migration, sha256, single_ledger_migration } from './catalog'

/** New SQL requires maintenance unless its exact bytes were reviewed for online use. */
export function sql_execution(files: MigrationFile[], dir: string) {
  const path = resolve(dir, 'deployment.json')
  const automatic: Record<string, string> = {}
  if (existsSync(path)) {
    const policy = JSON.parse(readFileSync(path, 'utf8'))
    if (policy.version !== 1 || ! policy.automatic_sql || typeof policy.automatic_sql !== 'object' || Array.isArray(policy.automatic_sql))
      throw new Error('Invalid migration deployment policy')
    for (const [filename, checksum] of Object.entries(policy.automatic_sql)) {
      const file = files.find(file => file.filename === filename && ! file.artifact)
      if (! file || typeof checksum !== 'string' || ! /^[a-f\d]{64}$/.test(checksum) || file.checksum !== checksum)
        throw new Error(`Invalid online SQL declaration: ${filename}`)
      automatic[filename] = checksum
    }
  }
  return (file: MigrationFile): 'automatic' | 'maintenance' =>
    file.filename <= legacy_baseline_through || [runtime_migration, single_ledger_migration].includes(file.filename) || automatic[file.filename] === file.checksum
      ? 'automatic'
      : 'maintenance'
}

export interface DeploymentMigration {
  filename: string
  checksum: string
  status: string
  phase: string
  execution: 'automatic' | 'maintenance'
}

export interface DeploymentPreflight {
  version: 1
  fingerprint: string
  database: { host: string, port: number, name: string, server_uuid: string }
  catalog: { filename: string, checksum: string }[]
  legacy: { filename: string, checksum: string }[]
  ledger: { filename: string, checksum: string, status: string, phase: string, attempts: number, finished: boolean }[]
  pending: DeploymentMigration[]
  requires_maintenance: boolean
  sql_recovery_required: string[]
}

export function deployment_fingerprint(report: Omit<DeploymentPreflight, 'fingerprint'>) {
  return sha256(JSON.stringify(report))
}
