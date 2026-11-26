import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import { load_database_config } from '@config/loader'
import { build } from 'esbuild'
import mysql from 'mysql2/promise'
import { initialize_cli_environment } from '../../config/lib/environment.mjs'
import { baseline_migration } from '../migration/baseline'
import { build_migration_scripts, maintenance_build_options } from '../migration/build'
import { runtime_migration, sha256 } from '../migration/catalog'
import { run_migrations } from '../migration/local'
import { package_native_runtime } from '../migration/native'

// Explicit verification only: create/drop fresh, uniquely named databases; never use business tables.
async function verify() {
  initialize_cli_environment()
  if (process.env.NODE_ENV !== 'development')
    throw new Error('Migration verification requires NODE_ENV=development')
  const config = load_database_config()
  assert(['127.0.0.1', 'localhost'].includes(config.host), 'Migration verification requires loopback MySQL')
  const root_password = process.env.MYSQL_DEV_ROOT_PASSWORD
  assert(root_password, 'MYSQL_DEV_ROOT_PASSWORD is required')
  const root = await mysql.createConnection({ host: config.host, port: config.port, user: 'root', password: root_password, timezone: 'Z' })
  const name = `stupig_migration_qa_${randomUUID().replaceAll('-', '')}`
  assert(/^stupig_migration_qa_[a-f\d]{32}$/.test(name))
  const dir = resolve(process.cwd(), '.nuxt/migration-qa', name)
  const created = new Set<string>()
  let probe: mysql.Connection | null = null
  const run = (options: Parameters<typeof run_migrations>[0] = {}) => run_migrations({ dir, database_config: { ... config, name, user: 'root', password: root_password }, ... options })
  try {
    await root.query(`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`)
    created.add(name)
    probe = await mysql.createConnection({ host: config.host, port: config.port, user: 'root', password: root_password, database: name, timezone: 'Z' })
    await mkdir(dir, { recursive: true })
    await writeFile(resolve(dir, runtime_migration), await readFile(resolve(process.cwd(), 'migrations', runtime_migration)))
    await writeFile(resolve(dir, '20261024015000_fixture.sql'), `CREATE TABLE fixture (n INT PRIMARY KEY, marker VARCHAR(32), connection_id BIGINT); INSERT INTO fixture VALUES (0, 'fail', NULL);`)
    const first = '20261024030000_transform.ts'
    await writeFile(resolve(dir, first), `export default {
        execution:'maintenance', async plan(){return {summary:'isolated fixture'}},
        async apply(ctx){for(let n=(ctx.checkpoint.value?.n??0)+1;n<=3;n++){
          const [[control]]=await ctx.db.query('SELECT marker FROM fixture WHERE n=0');
          if(n===3&&control.marker==='fail')throw new Error('injected failure');
          await ctx.transaction(async db=>{await db.execute('INSERT INTO fixture(n) VALUES (?)',[n]);await ctx.checkpoint.save({n})});
        }}, async verify({db}){const [[row]]=await db.query('SELECT COUNT(*) n FROM fixture WHERE n>0');return row.n===3}
      }`)
    await run({ dry_run: true })
    const [empty] = await probe.query<mysql.RowDataPacket[]>('SHOW TABLES')
    assert.equal(empty.length, 0)
    await assert.rejects(run(), /维护窗口/)
    await assert.rejects(run({ maintenance: true }), /已终止/)
    const [[checkpoint]] = await probe.query<mysql.RowDataPacket[]>('SELECT status, checkpoint FROM migration_runs WHERE filename=?', [first])
    assert.equal(checkpoint!.status, 'failed')
    assert.deepEqual(typeof checkpoint!.checkpoint === 'string' ? JSON.parse(checkpoint!.checkpoint) : checkpoint!.checkpoint, { n: 2 })
    await probe.query('UPDATE fixture SET marker=\'ready\' WHERE n=0')
    await run({ maintenance: true })
    await run({ maintenance: true })

    const second = '20261024040000_verify.ts'
    await writeFile(resolve(dir, second), `export default {
        execution:'automatic',async plan(){return {summary:'verify phase'}},
        async apply({db}){await db.execute('INSERT INTO fixture(n) VALUES (4)')},
        async verify({db}){const [[row]]=await db.query('SELECT marker FROM fixture WHERE n=0');return row.marker!=='verify_fail'}
      }`)
    await probe.query('UPDATE fixture SET marker=\'verify_fail\' WHERE n=0')
    await assert.rejects(run(), /已终止/)
    await probe.query('UPDATE fixture SET marker=\'ready\' WHERE n=0')
    await run()
    await writeFile(resolve(dir, '20261024050000_concurrent.ts'), `export default {
        execution:'automatic',async plan(){return {summary:'concurrency'}},
        async apply({db}){await db.query('SELECT SLEEP(0.3)');await db.execute('INSERT INTO fixture(n) VALUES (5)')},async verify(){return true}
      }`)
    const competing = await Promise.allSettled([run(), run()])
    for (const result of competing) {
      if (result.status === 'rejected')
        console.error('competing_migration_failed', { kind: result.reason?.constructor?.name, code: result.reason?.code, syscall: result.reason?.syscall })
    }
    assert(competing.every(result => result.status === 'fulfilled'))

    const killed = '20261024060000_disconnect.ts'
    await writeFile(resolve(dir, killed), `export default {
        execution:'automatic',async plan(){return {summary:'disconnect'}},
        async apply({db}){const [[row]]=await db.query('SELECT marker FROM fixture WHERE n=0');if(row.marker==='kill'){
          await db.execute('UPDATE fixture SET connection_id=CONNECTION_ID() WHERE n=0');await db.query('SELECT SLEEP(10)');
        }await db.execute('INSERT INTO fixture(n) VALUES (6)')},async verify(){return true}
      }`)
    await probe.query('UPDATE fixture SET marker=\'kill\' WHERE n=0')
    const interrupted = run().then(() => false, () => true)
    let connection_id = 0
    for (let n = 0; n < 100; n ++) {
      const [[row]] = await probe.query<mysql.RowDataPacket[]>('SELECT connection_id FROM fixture WHERE n=0')
      connection_id = Number(row!.connection_id ?? 0)
      if (connection_id)
        break
      await delay(20)
    }
    assert(Number.isSafeInteger(connection_id) && connection_id > 0)
    await root.query(`KILL CONNECTION ${connection_id}`)
    assert.equal(await interrupted, true)
    await probe.query('UPDATE fixture SET marker=\'ready\' WHERE n=0')
    await run()
    const [[total]] = await probe.query<mysql.RowDataPacket[]>('SELECT COUNT(*) n FROM fixture WHERE n>0')
    assert.equal(total!.n, 6)

    const partial = '20261024070000_partial.sql'
    const partial_sql = 'CREATE TABLE IF NOT EXISTS partial_fixture(n INT); INSERT INTO missing_fixture(n) VALUES (1);'
    await writeFile(resolve(dir, partial), partial_sql)
    // This fixture deliberately exercises an online SQL failure and explicit
    // recovery; new SQL otherwise stops at the maintenance admission gate.
    await writeFile(resolve(dir, 'deployment.json'), JSON.stringify({ version: 1, automatic_sql: { [partial]: sha256(partial_sql) } }))
    await assert.rejects(run(), /已终止/)
    await assert.rejects(run(), /retry-sql/)
    await probe.query('CREATE TABLE missing_fixture(n INT PRIMARY KEY)')
    await run({ retry_sql: partial })
    await run({ check_only: true })
    // Execute the actual production CLI + manifest + handler without source loaders/node_modules.
    const standalone = await mkdtemp(resolve(tmpdir(), 'stupig-migration-standalone-'))
    await mkdir(resolve(standalone, 'config'))
    await mkdir(resolve(standalone, 'migrations'))
    // eslint-disable-next-line no-template-curly-in-string -- YAML placeholders must be resolved by the standalone CLI, not this verifier.
    await writeFile(resolve(standalone, 'config/shared.yaml'), 'db:\n  host: ${MYSQL_HOST}\n  port: ${MYSQL_PORT}\n  user: ${MYSQL_USER}\n  password: ${MYSQL_PASSWORD}\n  name: ${MYSQL_DATABASE}\n')
    await writeFile(resolve(standalone, 'config/prod.yaml'), '{}\n')
    await writeFile(resolve(dir, '20261024080000_bundle.ts'), `export default {
      execution:'automatic',async plan(){return {summary:'standalone production artifact'}},
      async apply({db}){await db.execute('INSERT INTO fixture(n) VALUES (7)')},
      async verify({db}){const [[row]]=await db.query('SELECT COUNT(*) n FROM fixture WHERE n>0');return row.n===7}
    }`)
    for (const file of await readdir(dir)) {
      if (/\.(?:sql|ts)$/.test(file) || file === 'deployment.json')
        await copyFile(resolve(dir, file), resolve(standalone, 'migrations', file))
    }
    await build_migration_scripts(resolve(standalone, 'migrations'), resolve(standalone, 'migration-scripts'))
    const cli = resolve(standalone, 'migrate.mjs')
    await build({ ... maintenance_build_options, entryPoints: [resolve(process.cwd(), 'scripts/migration/cli.ts')], outfile: cli })
    const execute = promisify(execFile)
    const env = { ... process.env, NODE_ENV: 'production', MYSQL_HOST: config.host, MYSQL_PORT: String(config.port), MYSQL_USER: 'root', MYSQL_PASSWORD: root_password, MYSQL_DATABASE: name }
    await execute(process.execPath, [cli], { cwd: standalone, env })
    await execute(process.execPath, [cli], { cwd: standalone, env })
    const [[bundled]] = await probe.query<mysql.RowDataPacket[]>('SELECT COUNT(*) n FROM fixture WHERE n>0')
    assert.equal(bundled!.n, 7)
    const chain_name = `${name}_chain`
    await root.query(`CREATE DATABASE \`${chain_name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`)
    created.add(chain_name)
    const chain_options = { database_config: { ... config, name: chain_name, user: 'root', password: root_password }, maintenance: true }
    await run_migrations(chain_options)
    await run_migrations(chain_options)
    const [[fresh_legacy]] = await root.query<mysql.RowDataPacket[]>('SELECT COUNT(*) n FROM information_schema.TABLES WHERE TABLE_SCHEMA=? AND TABLE_NAME=?', [chain_name, 'schema_migrations'])
    assert.equal(fresh_legacy!.n, 0)
    await root.query(`SELECT display_key, fallback_key, source_display_key, lqip, redacted_display_key, redacted_fallback_key, redacted_lqip
      FROM \`${chain_name}\`.content_story_attachments LIMIT 0`)
    await root.query(`SELECT display_key, fallback_key FROM \`${chain_name}\`.content_image_attempts LIMIT 0`)
    await root.query(`SELECT attachment_id, adopted FROM \`${chain_name}\`.content_webp_migration_objects LIMIT 0`)

    const migration_dir = resolve(process.cwd(), 'migrations')
    const production_name = `${name}_production`
    await root.query(`CREATE DATABASE \`${production_name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`)
    created.add(production_name)
    const production = resolve(standalone, 'full')
    await mkdir(resolve(production, 'config'), { recursive: true })
    await mkdir(resolve(production, 'migrations'))
    await copyFile(resolve(standalone, 'config/shared.yaml'), resolve(production, 'config/shared.yaml'))
    await copyFile(resolve(standalone, 'config/prod.yaml'), resolve(production, 'config/prod.yaml'))
    await copyFile(cli, resolve(production, 'migrate.mjs'))
    for (const filename of await readdir(migration_dir)) {
      if (/\.(?:sql|ts)$/.test(filename) || filename === 'deployment.json')
        await copyFile(resolve(migration_dir, filename), resolve(production, 'migrations', filename))
    }
    const production_manifest = await build_migration_scripts(migration_dir, resolve(production, 'migration-scripts'))
    await package_native_runtime(production)
    const production_env = { ... env, MYSQL_DATABASE: production_name }
    await execute(process.execPath, [resolve(production, 'migrate.mjs'), '--maintenance'], { cwd: production, env: production_env })
    await execute(process.execPath, [resolve(production, 'migrate.mjs')], { cwd: production, env: production_env })
    const [[receipts]] = await root.query<mysql.RowDataPacket[]>(`SELECT COUNT(*) n FROM \`${production_name}\`.migration_runs WHERE status='completed'`)
    const production_scripts = JSON.parse(await readFile(production_manifest, 'utf8')).scripts
    assert.equal(Number(receipts!.n), (await readdir(migration_dir)).filter(filename => filename.endsWith('.sql')).length + production_scripts.length)

    // Use the production catalog in the temporary directory to reproduce a failure
    // after the baseline commits. Earlier SQL receipts must already be durable.
    const recovery_name = `${name}_recovery`
    await root.query(`CREATE DATABASE \`${recovery_name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`)
    created.add(recovery_name)
    const recovery_sql = '20261113000000_qa_recovery.sql'
    const recovery_dir = resolve(production, 'migrations')
    await writeFile(resolve(recovery_dir, recovery_sql), 'INSERT INTO qa_recovery_fixture VALUES (1);\n')
    const recovery_options = { ... chain_options, dir: recovery_dir, database_config: { ... chain_options.database_config, name: recovery_name } }
    await assert.rejects(run_migrations(recovery_options), { code: 'execution_failed' })
    const { preflight } = await run_migrations({ ... recovery_options, preflight: true })
    assert.deepEqual(preflight?.sql_recovery_required, [recovery_sql])
    assert.equal(preflight?.ledger.find(row => row.filename === baseline_migration)?.status, 'completed')
    await root.query(`CREATE TABLE \`${recovery_name}\`.qa_recovery_fixture (id INT PRIMARY KEY)`)
    await run_migrations({ ... recovery_options, retry_sql: recovery_sql })
    console.log('migration_verification_passed: empty/read-only, maintenance, checkpoint, verify-only, concurrent, disconnect, partial-DDL, repeat, production-bundle, baseline-schema, baseline-recovery')
  }
  finally {
    if (probe)
      await probe.end()
    // Only this invocation's successfully created database is eligible for cleanup.
    try {
      for (const target of created) {
        assert([name, `${name}_chain`, `${name}_production`, `${name}_recovery`].includes(target))
        await root.query(`DROP DATABASE \`${target}\``)
      }
    }
    finally { await root.end() }
  }
}

void verify().catch(() => {
  console.error('migration_verification_failed: inspect the last safe phase; credentials and SDK errors suppressed')
  process.exitCode = 1
})
