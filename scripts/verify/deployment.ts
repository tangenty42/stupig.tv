import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, resolve } from 'node:path'
import { promisify } from 'node:util'
import { load_database_config } from '@config/loader'
import mysql from 'mysql2/promise'
import { initialize_cli_environment } from '../../config/lib/environment.mjs'
import { release_plan, safe_rollback } from '../deploy/release'
import { build_maintenance } from '../migration/build'
import { run_migrations } from '../migration/local'

/** Exercise production upgrade admission against a uniquely owned loopback database. */
async function verify() {
  initialize_cli_environment()
  assert.equal(process.env.NODE_ENV, 'development')
  const config = load_database_config()
  assert.equal(config.host, '127.0.0.1')
  const password = process.env.MYSQL_DEV_ROOT_PASSWORD
  assert(password)
  const name = `stupig_deployment_qa_${randomUUID().replaceAll('-', '')}`
  assert.match(name, /^stupig_deployment_qa_[a-f\d]{32}$/)
  const connection = await mysql.createConnection({ host: config.host, port: config.port, user: 'root', password, timezone: 'Z' })
  let plan_directory: string | undefined
  try {
    await connection.query(`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`)
    await connection.changeUser({ database: name })
    const options = { database_config: { ... config, name, user: 'root', password } }
    await run_migrations({ ... options, maintenance: true, through: '20261025170000_storage_audit_cleanup.sql' })
    await connection.execute(`INSERT INTO content_stories (id,title,event_precision,event_dates,markdown,namespace_revision)
      VALUES (1,'fixture','day',JSON_ARRAY('2026-10-31'),?,0)`, ['# 原文字节\r\n[附件](att://example?a=1#part)\n'])
    const [before_rows] = await connection.query('SELECT id,SHA2(markdown,256) AS digest,revision,namespace_revision FROM content_stories ORDER BY id')
    const before = (await run_migrations({ ... options, preflight: true })).preflight!
    assert.equal(before.pending.length, 4)
    assert(before.pending.every(file => file.execution === 'maintenance'))
    const [ledger] = await connection.query('SELECT filename,checksum,status,attempts,finished_at FROM migration_runs ORDER BY filename')
    await assert.rejects(run_migrations(options), /维护窗口/)
    const [ledger_after] = await connection.query('SELECT filename,checksum,status,attempts,finished_at FROM migration_runs ORDER BY filename')
    assert.deepEqual(ledger_after, ledger, 'Ordinary startup must not commit the preceding expansion SQL')
    const [[column]] = await connection.query<mysql.RowDataPacket[]>(`SELECT COUNT(*) AS n FROM information_schema.columns
      WHERE table_schema=DATABASE() AND table_name='content_reference_journals' AND column_name='entry_index'`)
    assert.equal(Number(column!.n), 0)
    const hash = 'a'.repeat(64)
    const identity = { commit: 'a'.repeat(40), app: `registry.example/app@sha256:${hash}`, mqtt: `registry.example/app@sha256:${hash}`, environment_sha256: hash, compose_sha256: hash, previous_protocol: 'cloud-v1' as const, previous_release_sha256: hash }
    const plan = release_plan(before, identity)
    // Use the delivered production bundle, not a mocked release controller.
    await build_maintenance()
    const directory = await mkdtemp(resolve(tmpdir(), 'stupig-deployment-plan-'))
    plan_directory = directory
    const bundle = resolve(process.cwd(), '.output/server/maintenance/release.mjs')
    const execute = promisify(execFile)
    const bundle_env = {
      ... process.env, NODE_ENV: 'production', MYSQL_HOST: config.host, MYSQL_PORT: String(config.port), MYSQL_DATABASE: name,
      MYSQL_USER: 'root', MYSQL_PASSWORD: password, RELEASE_SHA: identity.commit,
      APP_IMAGE: identity.app, MQTT_IMAGE: identity.mqtt,
    }
    await writeFile(resolve(directory, '.env.prod'), 'isolated-plan-fixture=1\n')
    await writeFile(resolve(directory, 'docker-compose.yml'), 'services: {}\n')
    // The optional directory argument is used only by this isolated verifier.
    const command = async (... args: string[]) => execute(process.execPath, [bundle, ... args, '--directory', directory], { env: bundle_env, cwd: process.cwd() })
    await command('plan', 'new', 'cloud-v1', hash)
    const packaged_plan = JSON.parse(await readFile(resolve(directory, 'plan.json'), 'utf8'))
    await command('plan', packaged_plan.id, 'cloud-v1', hash)
    await writeFile(resolve(directory, 'decision.env'), 'DB_NAME=edited\n')
    await command('plan', packaged_plan.id, 'cloud-v1', hash)
    assert((await readFile(resolve(directory, 'decision.env'), 'utf8')).includes(`DB_NAME=${name}\n`))
    await writeFile(resolve(directory, '.env.prod'), 'changed=1\n')
    await assert.rejects(command('plan', packaged_plan.id, 'cloud-v1', hash))
    await writeFile(resolve(directory, '.env.prod'), 'isolated-plan-fixture=1\n')
    await run_migrations({ ... options, maintenance: true })
    const after = (await run_migrations({ ... options, preflight: true })).preflight!
    assert.equal(after.pending.length, 0)
    assert(after.ledger.every(row => row.status === 'completed' && row.finished))
    const [after_rows] = await connection.query('SELECT id,SHA2(markdown,256) AS digest,revision,namespace_revision FROM content_stories ORDER BY id')
    assert.deepEqual(after_rows, before_rows)
    const [[draft]] = await connection.query<mysql.RowDataPacket[]>(`SELECT COUNT(*) AS n FROM content_story_drafts d JOIN content_stories s ON d.story_id=s.id
      WHERE BINARY d.markdown=BINARY s.markdown AND d.published_main_revision=s.revision AND d.unpublished_changes=0`)
    assert.equal(Number(draft!.n), 1)
    assert.equal(safe_rollback(before, after), false, 'A shared protocol marker does not make schema rollback safe')
    assert.notEqual(release_plan(after, identity).id, plan.id, 'Old approval must expire when the ledger changes')
    await assert.rejects(command('plan', packaged_plan.id, 'cloud-v1', hash))
    await assert.rejects(command('rollback'))
    await connection.execute('UPDATE content_story_drafts SET published_main_revision = NULL')
    await assert.rejects(command('verify', 'before-start'), 'A missing published revision must fail backfill acceptance')
    await connection.execute('UPDATE content_story_drafts d JOIN content_stories s ON s.id=d.story_id SET d.published_main_revision=s.revision')
    await command('verify', 'before-start')
    await command('receipt', 'maintenance', 'integration-1')
    const receipt = JSON.parse(await readFile(resolve(directory, 'result.json'), 'utf8'))
    assert.equal(receipt.plan_id, packaged_plan.id)
    assert.equal(receipt.execution_id, 'integration-1')
    console.log('Deployment admission, zero-write rejection, maintenance upgrade, byte preservation and rollback fencing passed')
  }
  finally {
    await connection.query(`DROP DATABASE IF EXISTS \`${name}\``)
    await connection.end()
    if (plan_directory) {
      assert.equal(dirname(resolve(plan_directory)), resolve(tmpdir()))
      assert(basename(plan_directory).startsWith('stupig-deployment-plan-'))
      await rm(plan_directory, { recursive: true, force: true })
    }
  }
}

verify().catch(() => {
  console.error('Isolated deployment verification failed; production targets are not supported')
  process.exitCode = 1
})
