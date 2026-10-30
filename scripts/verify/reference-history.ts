import type { MigrationContext } from '../migration/contract'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { load_database_config } from '@config/loader'
import { append_reference_journal, reference_journals_since } from '@server/services/content/reference-journal.repository'
import { replay_content_references } from '@shared/content-reference-replay'
import mysql from 'mysql2/promise'
import { initialize_cli_environment } from '../../config/lib/environment.mjs'
import conversion from '../../migrations/20261028210100_reference_journal_entries'
import { run_migrations } from '../migration/local'

/** Explicit local verification: only newly created, uniquely named databases are written. */
async function verify() {
  initialize_cli_environment()
  assert.equal(process.env.NODE_ENV, 'development')
  const config = load_database_config()
  assert.equal(config.host, '127.0.0.1', 'Reference verification only supports local MySQL')
  const password = process.env.MYSQL_DEV_ROOT_PASSWORD
  assert(password, 'Development root password is required')
  const connection_options = { host: config.host, port: config.port, user: 'root', password, timezone: 'Z' }
  const root = await mysql.createConnection(connection_options)
  const prefix = `stupig_reference_qa_${randomUUID().replaceAll('-', '')}`
  assert.match(prefix, /^stupig_reference_qa_[a-f\d]{32}$/)
  const created = new Set<string>()
  let db: mysql.Connection | null = null
  try {
    for (const mode of ['empty', 'upgrade']) {
      const name = `${prefix}_${mode}`
      await root.query(`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`)
      created.add(name)
      db = await mysql.createConnection({ ... connection_options, database: name })
      const options = { database_config: { ... config, name, user: 'root', password }, maintenance: true }
      if (mode === 'upgrade') {
        await run_migrations({ ... options, through: '20261025170000_storage_audit_cleanup.sql' })
        await db.execute('INSERT INTO content_stories (id, title, event_precision, event_dates, markdown, namespace_revision) VALUES (1, \'fixture\', \'day\', JSON_ARRAY(\'2026-10-28\'), \'\', 201)')
        await db.execute('UPDATE content_title_namespace SET revision = 201 WHERE id = 1')
        for (const scope of [0, 1]) {
          for (let revision = 1; revision <= 201; revision ++) {
            const changes = revision === 2
              ? Array.from({ length: 250 }, (_, index) => ({ node_id: index + 1, from: `Old${index}`, to: `New${index}`, is_folder: false }))
              : [{ node_id: 1, from: `Name${revision - 1}`, to: `Name${revision}`, is_folder: false }]
            await db.execute('INSERT INTO content_reference_journals (scope_id, revision, changes) VALUES (?, ?, CAST(? AS JSON))', [scope, revision, JSON.stringify(changes)])
          }
        }
        await run_migrations({ ... options, through: '20261028210000_reference_journal_entries.sql' })
        let checks = 0
        const context: MigrationContext = {
          filename: '20261028210100_reference_journal_entries.ts', db, signal: new AbortController().signal,
          checkpoint: { value: null, save: async () => {} },
          assert_active: async () => {
            if (++ checks === 4)
              throw new Error('injected interruption')
          },
          transaction: async (work) => {
            await db!.beginTransaction()
            try {
              const result = await work(db!)
              await db!.commit()
              return result
            }
            catch (error) {
              await db!.rollback()
              throw error
            }
          },
          oss: async () => { throw new Error('Reference conversion must not access OSS') },
        }
        await assert.rejects(conversion.apply(context), /injected interruption/)
        const [[converted]] = await db.execute<mysql.RowDataPacket[]>('SELECT COUNT(*) AS count FROM content_reference_journals WHERE changes IS NULL')
        assert(Number(converted!.count) > 0)
      }
      await run_migrations(options)
      await run_migrations(options)
      assert.equal(await conversion.verify({ filename: '', db, signal: new AbortController().signal, checkpoint: { value: null } }), true)
      const [[legacy]] = await db.execute<mysql.RowDataPacket[]>('SELECT COUNT(*) AS count FROM information_schema.columns WHERE table_schema = DATABASE() AND column_name IN (\'changes\', \'related_story_ids\') AND table_name IN (\'content_stories\', \'content_reference_journals\')')
      assert.equal(Number(legacy!.count), 0)
      if (mode === 'upgrade') {
        for (const scope of [0, 1]) {
          const history = await reference_journals_since(db, scope, 1, 201, 1)
          assert.equal(history.journals.length, 200)
          assert.equal(history.journals[0]!.changes.length, 250)
          assert.equal(history.journals[0]!.changes[0]!.from, `${scope === 0 ? 'content' : 'att'}://Old0`)
          assert.equal((await reference_journals_since(db, scope, 0, 201, 1)).unavailable, true)
          const scheme = scope === 0 ? 'content://' : 'att://'
          await db.beginTransaction()
          await append_reference_journal(db, scope, 202, [{ node_id: 1, from: `${scheme}Name201`, to: `${scheme}Final` }])
          await db.rollback()
          assert.equal((await reference_journals_since(db, scope, 1, 202, 1)).journals.length, 200)
          const [[floor_before]]: [mysql.RowDataPacket[], mysql.FieldPacket[]] = await db.execute<mysql.RowDataPacket[]>(scope === 0 ? 'SELECT revision_floor AS floor FROM content_title_namespace WHERE id = 1' : 'SELECT namespace_floor AS floor FROM content_stories WHERE id = 1')
          assert.equal(Number(floor_before!.floor), 1)
          await db.beginTransaction()
          await append_reference_journal(db, scope, 202, [{ node_id: 1, from: `${scheme}Name201`, to: `${scheme}Final` }])
          await db.commit()
          const history_after = await reference_journals_since(db, scope, 201, 202, 2)
          const result = replay_content_references(`[](${scheme}NAME201?x=1#part)`, {
            attachments: scope ? history_after.journals : [], titles: scope ? [] : history_after.journals,
            attachment_targets: [{ id: 1, name: 'Final' }], title_targets: [{ id: 1, name: 'Final' }],
          })
          assert.equal(result.markdown, `[](${scheme}Final?x=1#part)`)
          const [[count]]: [mysql.RowDataPacket[], mysql.FieldPacket[]] = await db.execute<mysql.RowDataPacket[]>('SELECT COUNT(DISTINCT revision) AS count, MIN(revision) AS oldest FROM content_reference_journals WHERE scope_id = ?', [scope])
          assert.equal(Number(count!.count), 200)
          assert.equal(Number(count!.oldest), 3)
        }
      }
      await db.end()
      db = null
      console.info(`reference history ${mode}: passed`)
    }
  }
  finally {
    await db?.end()
    for (const name of created) {
      assert(name === `${prefix}_empty` || name === `${prefix}_upgrade`)
      await root.query(`DROP DATABASE \`${name}\``)
    }
    await root.end()
  }
}

verify().catch((error: unknown) => {
  console.error('reference history verification failed', error instanceof Error ? error.message : 'unknown error')
  process.exitCode = 1
})
