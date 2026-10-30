import type { DeploymentPreflight } from '../migration/deployment'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { load_database_config, runtime_config } from '@config/loader'
import mysql from 'mysql2/promise'
import { sha256 } from '../migration/catalog'
import { run_migrations } from '../migration/runner'
import { verify_public } from './verify-public'

export interface ReleaseIdentity {
  commit: string
  app: string
  mqtt: string
  environment_sha256: string
  compose_sha256: string
  previous_protocol: 'legacy' | 'cloud-v1'
  previous_release_sha256: string
}

export function release_plan(migrations: DeploymentPreflight, identity: ReleaseIdentity) {
  if (! /^[a-f\d]{40}$/.test(identity.commit)
    || ! [identity.app, identity.mqtt].every(value => /^[a-z\d.\-/:]+@sha256:[a-f\d]{64}$/.test(value))
    || ! [identity.environment_sha256, identity.compose_sha256, identity.previous_release_sha256].every(value => /^[a-f\d]{64}$/.test(value))
    || ! ['legacy', 'cloud-v1'].includes(identity.previous_protocol)) {
    throw new Error('Invalid immutable release identity')
  }
  const payload = { version: 1, identity, migrations }
  return { ... payload, id: sha256(JSON.stringify(payload)), requires_maintenance: migrations.requires_maintenance || identity.previous_protocol !== 'cloud-v1' }
}

export type ReleasePlan = ReturnType<typeof release_plan>

/** Only the reviewed online steps may change the ledger during a normal rollback. */
export function safe_rollback(before: DeploymentPreflight, after: DeploymentPreflight) {
  if (JSON.stringify(before.database) !== JSON.stringify(after.database)
    || JSON.stringify(before.catalog) !== JSON.stringify(after.catalog)
    || after.ledger.some(row => row.status !== 'completed' || ! row.finished)) {
    return false
  }
  const current = new Map(after.ledger.map(row => [row.filename, row]))
  if (before.ledger.some(row => row.status !== 'completed' || ! row.finished || current.get(row.filename)?.checksum !== row.checksum))
    return false
  const old = new Set(before.ledger.map(row => row.filename))
  return after.ledger.filter(row => ! old.has(row.filename)).every(row => before.pending.some(file => file.filename === row.filename && file.checksum === row.checksum && file.execution === 'automatic'))
}

export function decision_environment(plan: ReleasePlan) {
  const database = plan.migrations.database
  if (! /^[\w.:-]+$/.test(database.host) || ! /^\w+$/.test(database.name) || ! /^[a-f\d-]{36}$/i.test(database.server_uuid))
    throw new Error('Database target cannot be safely backed up by this maintenance workflow')
  const backfill = plan.migrations.pending.some(file => file.filename === '20261030120000_shared_content_drafts.sql')
  const content_ready = plan.migrations.ledger.some(row => row.filename === '20261024210200_content_workspace.ts' && row.status === 'completed')
  return `PLAN_ID=${plan.id}\nMAINTENANCE_REQUIRED=${Number(plan.requires_maintenance)}\nSQL_RECOVERY_REQUIRED=${Number(plan.migrations.sql_recovery_required.length > 0)}\nDB_HOST=${database.host}\nDB_NAME=${database.name}\nDB_UUID=${database.server_uuid}\nCLOUD_BACKFILL=${Number(backfill)}\nVERIFY_MAIN_UNCHANGED=${Number(backfill && content_ready)}\n`
}

async function verify_data(plan: ReleasePlan, after: DeploymentPreflight, check_backfill: boolean) {
  if (after.pending.length || after.ledger.some(row => row.status !== 'completed' || ! row.finished))
    throw new Error('Migration completion receipts are incomplete')
  if (! check_backfill || ! plan.migrations.pending.some(file => file.filename === '20261030120000_shared_content_drafts.sql'))
    return
  const { name, ... config } = load_database_config()
  const connection = await mysql.createConnection({ ... config, database: name, timezone: 'Z' })
  try {
    const [rows] = await connection.query<mysql.RowDataPacket[]>(`SELECT
      (SELECT COUNT(*) FROM content_stories) AS stories,
      (SELECT COUNT(*) FROM content_story_drafts) AS drafts,
      (SELECT COUNT(*) FROM content_title_namespace WHERE id = 1) AS title_baselines,
      (SELECT COUNT(*) FROM content_stories s LEFT JOIN content_story_drafts d ON d.story_id = s.id
        CROSS JOIN content_title_namespace t WHERE t.id = 1 AND
        (d.id IS NULL OR NOT (BINARY d.markdown <=> BINARY s.markdown)
        OR d.namespace_revision != s.namespace_revision OR d.title_revision != t.revision
        OR d.published_main_revision != s.revision OR d.unpublished_changes != 0)) AS mismatches`)
    const row = rows[0]!
    if (Number(row.title_baselines) !== 1 || Number(row.stories) !== Number(row.drafts) || Number(row.mismatches))
      throw new Error('Cloud draft backfill verification failed')
    console.log(JSON.stringify({ stories: Number(row.stories), drafts: Number(row.drafts), mismatches: 0 }))
  }
  finally { await connection.end() }
}

export async function release_cli(args: string[], directory = '/release') {
  const [command, expected, previous_protocol, previous_release_sha256] = args
  if (command === 'verify-public') {
    const config = runtime_config()
    await verify_public({ site: config.site.url, public_ws: config.mqtt.web.wsUrl, draft_ws: config.mqtt.web.draftWsUrl || new URL('/mqtt-drafts', config.mqtt.web.wsUrl).href })
    console.log('Public HTTP and MQTT acceptance passed')
    return
  }
  if (! ['plan', 'verify', 'rollback', 'receipt'].includes(command ?? ''))
    throw new Error('Unknown release operation')
  const result = await run_migrations({ preflight: true, manifest: resolve(import.meta.dirname, 'migration-scripts/manifest.json') })
  const migrations = result.preflight!
  if (command === 'verify' || command === 'rollback' || command === 'receipt') {
    const plan = JSON.parse(readFileSync(resolve(directory, 'plan.json'), 'utf8')) as ReleasePlan
    if (command === 'rollback') {
      if (! safe_rollback(plan.migrations, migrations))
        throw new Error('Database state does not permit automatic rollback')
    }
    else {
      await verify_data(plan, migrations, command === 'verify' && expected === 'before-start')
      if (command === 'receipt') {
        if (! /^[a-z\d-]{1,80}$/i.test(previous_protocol ?? ''))
          throw new Error('Invalid deployment execution identity')
        writeFileSync(resolve(directory, 'result.json'), `${JSON.stringify({
          plan_id: plan.id, identity: plan.identity, status: 'application_ready',
          mode: expected, completed_at: new Date().toISOString(), migration_fingerprint: migrations.fingerprint,
          execution_id: previous_protocol,
          acceptance: ['container_health', 'public_http', 'public_mqtt', 'private_mqtt_rejections'],
        }, null, 2)}\n`, { mode: 0o600 })
      }
    }
    return
  }
  const plan = release_plan(migrations, {
    commit: process.env.RELEASE_SHA ?? '', app: process.env.APP_IMAGE ?? '', mqtt: process.env.MQTT_IMAGE ?? '',
    environment_sha256: sha256(readFileSync(resolve(directory, '.env.prod'))),
    compose_sha256: sha256(readFileSync(resolve(directory, 'docker-compose.yml'))),
    previous_protocol: previous_protocol as ReleaseIdentity['previous_protocol'],
    previous_release_sha256,
  })
  if (expected !== 'new') {
    if (! /^[a-f\d]{64}$/.test(expected ?? '') || expected !== plan.id)
      throw new Error('Approved plan changed; run preflight again before maintenance')
    const approved = JSON.parse(readFileSync(resolve(directory, 'plan.json'), 'utf8'))
    if (JSON.stringify(approved) !== JSON.stringify(plan))
      throw new Error('Stored approval does not match the current plan')
  }
  else {
    writeFileSync(resolve(directory, 'plan.json'), `${JSON.stringify(plan, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
  }
  // Regenerate validated fields instead of trusting a separately edited shell file.
  writeFileSync(resolve(directory, 'decision.env'), decision_environment(plan), { mode: 0o600 })
  console.log(`Release ${plan.identity.commit}; plan ${plan.id}; maintenance=${plan.requires_maintenance}`)
  if (plan.requires_maintenance)
    console.log('Maintenance approval covers stopping writers, verified database backup, these migrations and service recovery; external workers/cron must be stopped separately.')
  for (const file of plan.migrations.pending)
    console.log(`${file.filename}: ${file.execution} (${file.status})`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2)
  const directory_index = args.indexOf('--directory')
  const directory = directory_index < 0 ? '/release' : args.splice(directory_index, 2)[1]
  release_cli(args, directory).catch(() => {
    // The private deployment log retains command status, never raw SDK/SQL errors.
    console.error('Release check failed; verify the plan, database state and public routes')
    process.exitCode = 1
  })
}
