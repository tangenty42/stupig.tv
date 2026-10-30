import type { AuthUser } from '@server/types/auth'
import type { DraftCommand, DraftLease } from '@shared/types/content-draft'
import type { Pool, RowDataPacket } from 'mysql2/promise'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { load_database_config, runtime_config } from '@config/loader'
import mysql from 'mysql2/promise'
import { initialize_cli_environment } from '../../config/lib/environment.mjs'
import { run_migrations } from '../migration/local'

/** Writes only a newly created random QA database; never migrate a business DB. */
async function verify() {
  initialize_cli_environment()
  assert.equal(process.env.NODE_ENV, 'development')
  // These providers are not exercised by protocol QA; never load their real
  // credentials merely to construct the API service dependency graph.
  Object.assign(process.env, {
    ALIYUN_OSS_ACCESS_KEY_ID: 'qa-local-only', ALIYUN_OSS_ACCESS_KEY_SECRET: 'qa-local-only',
    ALIYUN_DYPNS_ACCESS_KEY_ID: 'qa-local-only', ALIYUN_DYPNS_ACCESS_KEY_SECRET: 'qa-local-only', ALIYUN_DYPNS_CAPTCHA_APP_KEY: 'qa-local-only',
    JWT_SECRET: randomBytes(32).toString('hex'), NUXT_OTP_DEBUG: 'true', NUXT_CAPTCHA_DEBUG: 'true',
  })
  const base = load_database_config()
  assert(['127.0.0.1', 'localhost'].includes(base.host))
  const password = process.env.MYSQL_DEV_ROOT_PASSWORD
  assert(password, 'Local QA requires MYSQL_DEV_ROOT_PASSWORD')
  const name = `stupig_cloud_draft_qa_${randomBytes(16).toString('hex')}`
  assert.match(name, /^stupig_cloud_draft_qa_[a-f0-9]{32}$/)
  const config = { ... base, name, user: 'root', password }
  const root = await mysql.createConnection({ host: base.host, port: base.port, user: 'root', password, timezone: 'Z' })
  let pool: Pool | undefined
  let created = false
  let checks = 0
  const check = (label: string) => {
    checks ++
    console.log(`cloud-draft QA: ${label}`)
  }
  try {
    await root.query(`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`)
    created = true
    await run_migrations({ database_config: config, maintenance: true, through: '20261028210200_reference_journal_contract.sql' })
    await root.query(`INSERT INTO \`${name}\`.content_stories (title, event_precision, event_dates, markdown) VALUES ('Target', 'day', JSON_ARRAY('2026-10-30'), ?)`, ['---\ntitle: Target\ntime: 2026/10/30\n---\n[](att://old/file.txt) [ordinary](relative.pdf)'])
    await run_migrations({ database_config: config, maintenance: true })
    await run_migrations({ database_config: config, maintenance: true })
    const runtime = runtime_config()
    runtime.db = config
    runtime.app.auth.jwt.secret = randomBytes(32).toString('hex')
    runtime.integrations.mqtt.topicPrefix = `stupig/sync/qa-${randomBytes(8).toString('hex')}`
    const { db } = await import('@server/lib/db')
    pool = db
    const { get_draft, create_draft, acquire_draft, command_draft, list_drafts } = await import('@server/services/content/draft.service')
    const { ensure_workspace_root } = await import('@server/services/content/workspace.repository')
    const { with_namespace_change } = await import('@server/services/content/reference-history.service')
    const { draft_sync_credentials, authenticate_draft_sync } = await import('@server/services/content/draft-sync.service')
    async function actor(index: number): Promise<AuthUser> {
      const [user] = await db.execute<mysql.ResultSetHeader>('INSERT INTO users (username, phone, password_hash, is_admin) VALUES (?, ?, ?, 1)', [`qa${index}`, `1990000000${index}`, 'not-used-for-login'])
      const [session] = await db.execute<mysql.ResultSetHeader>('INSERT INTO user_login_sessions (user_id, login_at, last_seen_at, expires_at) VALUES (?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, TIMESTAMPADD(DAY, 1, CURRENT_TIMESTAMP))', [user.insertId])
      const [token] = await db.execute<mysql.ResultSetHeader>('INSERT INTO user_login_session_tokens (session_id, token_hash, expires_at) VALUES (?, ?, TIMESTAMPADD(DAY, 1, CURRENT_TIMESTAMP))', [session.insertId, randomBytes(32).toString('hex')])
      return { id: user.insertId, session_id: session.insertId, token_generation_id: token.insertId, username: `qa${index}`, phone: `1990000000${index}`, is_admin: true, is_verified: false, avatar_file: null }
    }
    const a = await actor(1)
    const b = await actor(2)
    const initial = (await get_draft(a, { story_id: 1 })).snapshot!
    assert(initial.markdown.endsWith('[ordinary](relative.pdf)'))
    assert.equal(initial.unpublished_changes, false)
    check('upgrade preserves exact main and current baselines; repeat migration is harmless')
    const request = randomBytes(16).toString('hex')
    const draft = (await create_draft(a, request)).snapshot!
    assert.equal((await create_draft(a, request)).snapshot!.id, draft.id)
    assert.notEqual((await create_draft(a, randomBytes(16).toString('hex'))).snapshot!.id, draft.id)
    const first_page = await list_drafts(a, '', 1)
    assert.equal(first_page.items.length, 1)
    assert(first_page.next)
    const second_page = await list_drafts(a, first_page.next, 1)
    assert.equal(second_page.items.length, 1)
    assert.notEqual(first_page.items[0]!.id, second_page.items[0]!.id)
    assert.equal(first_page.items[0]!.title, '新建档案')
    assert.equal(first_page.items[0]!.story_id, null)
    assert(! ('markdown' in first_page.items[0]!))
    assert(! (await list_drafts(a)).items.some(item => item.id === initial.id))
    check('new drafts have separate identity and creation retry is idempotent')
    const token_a = randomBytes(32).toString('hex')
    const token_b = randomBytes(32).toString('hex')
    const page_a = randomBytes(16).toString('hex')
    const page_b = randomBytes(16).toString('hex')
    const race = await Promise.all([
      acquire_draft(a, { id: initial.id, expected_epoch: 0, page_id: page_a, token: token_a }),
      acquire_draft(b, { id: initial.id, expected_epoch: 0, page_id: page_b, token: token_b }),
    ])
    assert.equal(race.filter(result => result.snapshot!.owned).length, 1)
    const owner = race[0]!.snapshot!.owned ? a : b
    let lease: DraftLease = race[0]!.snapshot!.owned ? { epoch: 1, page_id: page_a, token: token_a } : { epoch: 1, page_id: page_b, token: token_b }
    let seq = 0
    async function send(kind: DraftCommand['kind'], rest: Partial<DraftCommand> = {}) {
      const current = (await get_draft(owner, { id: initial.id, lease })).snapshot!
      const input: DraftCommand = { id: initial.id, lease, kind, seq: seq + 1, base_namespace_revision: current.namespace_revision, base_title_revision: current.title_revision, ... rest }
      const result = await command_draft(owner, input)
      if (result.receipt && ! ['lease_lost', 'command_order'].includes(result.receipt.error ?? ''))
        seq = result.receipt.seq
      return { input, result }
    }
    check('two different sessions racing on one row have exactly one writer')
    const saved = await send('sync', { markdown: '<good>unfinished [file](relative.pdf)' })
    assert(saved.result.receipt!.ok)
    const modified = (await list_drafts(a)).items.find(item => item.id === initial.id)
    assert.equal(modified?.story_id, 1)
    assert.equal(modified.title, '未命名草稿')
    const [outbox_before] = await db.execute<RowDataPacket[]>('SELECT COUNT(*) AS n FROM content_sync_outbox')
    const [lease_before] = await db.execute<RowDataPacket[]>('SELECT lease_until FROM content_story_drafts WHERE id = ?', [initial.id])
    await delay(5)
    const repeated = await command_draft(owner, saved.input)
    assert.deepEqual(repeated.receipt, saved.result.receipt)
    assert.equal(repeated.snapshot!.draft_revision, saved.result.snapshot!.draft_revision)
    const [outbox_after] = await db.execute<RowDataPacket[]>('SELECT COUNT(*) AS n FROM content_sync_outbox')
    const [lease_after] = await db.execute<RowDataPacket[]>('SELECT lease_until FROM content_story_drafts WHERE id = ?', [initial.id])
    assert.equal(outbox_before[0]!.n, outbox_after[0]!.n)
    assert.deepEqual(lease_before, lease_after)
    assert.equal((await command_draft(owner, { ... saved.input, markdown: 'different payload' })).receipt!.error, 'command_order')
    check('unfinished text saves verbatim; duplicate command neither writes nor renews or enqueues')
    const stale_publish = await send('publish', { expected_revision: saved.result.snapshot!.draft_revision + 1 })
    assert.equal(stale_publish.result.receipt!.error, 'snapshot_changed')
    const invalid = await send('publish', { expected_revision: saved.result.snapshot!.draft_revision })
    assert.equal(invalid.result.receipt!.error, 'validation_failed')
    const [mains] = await db.execute<RowDataPacket[]>('SELECT title, revision FROM content_stories WHERE id = 1')
    assert.equal(mains[0]!.revision, 1)
    check('invalid Markdown can autosave but cannot publish or change main')
    const valid = '---\ntitle: RenamedTarget\ntime: 2026/10/30\n---\n[](att://old/file.txt)'
    const fixed = await send('sync', { markdown: valid })
    const published = await send('publish', { expected_revision: fixed.result.snapshot!.draft_revision })
    assert(published.result.receipt!.ok)
    assert.equal(published.result.snapshot!.unpublished_changes, false)
    assert.equal(published.result.receipt!.main_revision, 2)
    assert(! (await list_drafts(a)).items.some(item => item.id === initial.id))
    check('publish changes main and draft atomically and realigns their revisions')
    const [all_heads] = await db.execute<RowDataPacket[]>('SELECT DISTINCT title_revision FROM content_story_drafts')
    const [title_head] = await db.execute<RowDataPacket[]>('SELECT revision FROM content_title_namespace')
    assert(all_heads.every(row => Number(row.title_revision) === Number(title_head[0]!.revision)))
    check('title changes advance every persisted draft, including unpublished drafts')
    const connection = await db.getConnection()
    let root_id: number
    try {
      await connection.beginTransaction()
      root_id = await ensure_workspace_root(connection, 1)
      await connection.commit()
    }
    finally { connection.release() }
    await with_namespace_change(1, async (connection) => {
      await connection.execute(`INSERT INTO content_story_attachments (story_id, parent_id, name, name_key, file_name, is_folder, version, storage_provider)
        VALUES (1, ?, 'old', 'old', 'old', 1, '', 'aliyun')`, [root_id])
    })
    await with_namespace_change(1, async (connection) => {
      await connection.execute('UPDATE content_story_attachments SET file_name = \'new\', name = \'new\', name_key = \'new\' WHERE story_id = 1 AND file_name = \'old\'')
    })
    const remapped = (await get_draft(owner, { id: initial.id, lease })).snapshot!
    assert(remapped.markdown.includes('att://new/file.txt'))
    assert.equal(remapped.namespace_revision, 2)
    assert.equal(remapped.unpublished_changes, false)
    // A still-in-flight old input uses its own reference baseline.
    const stale = await send('sync', { markdown: `${valid}\nmore`, base_namespace_revision: 0, base_title_revision: published.result.snapshot!.title_revision })
    assert(stale.result.snapshot!.markdown.includes('att://new/file.txt'))
    check('namespace creation and rename update main/draft and old input cannot restore an old name')
    const before_failure = stale.result.snapshot!
    await db.query('CREATE TRIGGER qa_reject_outbox BEFORE INSERT ON content_sync_outbox FOR EACH ROW SIGNAL SQLSTATE \'45000\' SET MESSAGE_TEXT = \'qa injected outbox failure\'')
    await assert.rejects(send('sync', { markdown: 'must roll back' }))
    await db.query('DROP TRIGGER qa_reject_outbox')
    const after_failure = (await get_draft(owner, { id: initial.id, lease })).snapshot!
    assert.equal(after_failure.markdown, before_failure.markdown)
    assert.equal(after_failure.draft_revision, before_failure.draft_revision)
    check('outbox failure rolls back text, revision, lease and receipt')
    const reviewed = await send('sync', { markdown: 'unknown history', base_title_revision: null })
    assert.equal(reviewed.result.receipt!.error, 'reference_review_required')
    const confirmed = await send('sync', { markdown: 'unknown history', base_title_revision: null, confirm_reference_history: reviewed.result.receipt!.review_token })
    assert(confirmed.result.receipt!.ok)
    check('history review is bound to the exact snapshot and consumes its own command')
    const credential = await draft_sync_credentials(owner)
    assert.equal((await authenticate_draft_sync(credential)).result, 'allow')
    assert.equal((await authenticate_draft_sync({ ... credential, password: `${credential.password}x` })).result, 'deny')
    check('MQTT credentials are signed, scoped and verified against the current session')
    // Reproduce an authenticated request queued on a content row while login
    // reuses the same session id and revokes its old token generations.
    const blocker = await db.getConnection()
    try {
      await blocker.beginTransaction()
      await blocker.execute('SELECT id FROM content_story_drafts WHERE id = ? FOR UPDATE', [initial.id])
      const old_request = command_draft(owner, { id: initial.id, lease, kind: 'sync', seq: seq + 1, base_namespace_revision: null, base_title_revision: null })
      const rejected = assert.rejects(old_request, (error: unknown) => (error as { statusCode?: number }).statusCode === 401)
      await delay(30)
      await db.execute('DELETE FROM user_login_session_tokens WHERE session_id = ?', [owner.session_id])
      const [next_token] = await db.execute<mysql.ResultSetHeader>('INSERT INTO user_login_session_tokens (session_id, token_hash, expires_at) VALUES (?, ?, TIMESTAMPADD(DAY, 1, CURRENT_TIMESTAMP))', [owner.session_id, randomBytes(32).toString('hex')])
      await blocker.commit()
      await rejected
      assert.equal((await authenticate_draft_sync(credential)).result, 'deny')
      owner.token_generation_id = next_token.insertId
    }
    finally {
      await blocker.rollback()
      blocker.release()
    }
    check('queued old-generation request and old MQTT ticket stay revoked after session-id reuse')
    await db.execute('INSERT INTO user_login_session_tokens (session_id, token_hash, expires_at) VALUES (?, ?, TIMESTAMPADD(DAY, 1, CURRENT_TIMESTAMP))', [owner.session_id, randomBytes(32).toString('hex')])
    assert((await send('sync')).result.receipt!.ok)
    check('normal token rotation keeps a still-valid presented generation usable')
    const expiry_blocker = await db.getConnection()
    try {
      await expiry_blocker.beginTransaction()
      await expiry_blocker.execute('SELECT id FROM content_story_drafts WHERE id = ? FOR UPDATE', [initial.id])
      const waiting = command_draft(owner, { id: initial.id, lease, seq: seq + 1, kind: 'sync', base_namespace_revision: null, base_title_revision: null })
      await delay(30)
      await expiry_blocker.execute('UPDATE content_story_drafts SET lease_until = TIMESTAMPADD(SECOND, -1, CURRENT_TIMESTAMP(3)) WHERE id = ?', [initial.id])
      await expiry_blocker.commit()
      assert.equal((await waiting).receipt!.error, 'lease_lost')
    }
    finally {
      await expiry_blocker.rollback()
      expiry_blocker.release()
    }
    const new_page = randomBytes(16).toString('hex')
    const new_token = randomBytes(32).toString('hex')
    const acquired = await acquire_draft(owner, { id: initial.id, expected_epoch: lease.epoch, page_id: new_page, token: new_token })
    assert(acquired.snapshot!.owned)
    const old_release = await command_draft(owner, { id: initial.id, lease, seq: seq + 1, kind: 'release', base_namespace_revision: null, base_title_revision: null })
    assert.equal(old_release.receipt!.error, 'lease_lost')
    lease = { epoch: acquired.snapshot!.lease_epoch, page_id: new_page, token: new_token }
    seq = 0
    const release = await send('release', { markdown: 'last snapshot' })
    assert(release.result.receipt!.ok)
    assert.equal(release.result.snapshot!.owned, false)
    assert.equal(release.result.snapshot!.markdown, 'last snapshot')
    check('expiry is evaluated after lock wait; stale release cannot affect the new epoch; final save/release is atomic')
    const draft_page = randomBytes(16).toString('hex')
    const draft_token = randomBytes(32).toString('hex')
    const new_head = (await get_draft(a, { id: draft.id })).snapshot!
    const new_lease_result = await acquire_draft(a, { id: draft.id, expected_epoch: new_head.lease_epoch, page_id: draft_page, token: draft_token })
    assert(new_lease_result.snapshot!.owned)
    const new_lease = { epoch: new_lease_result.snapshot!.lease_epoch, page_id: draft_page, token: draft_token }
    const new_text: DraftCommand = { id: draft.id, lease: new_lease, kind: 'sync', seq: 1, markdown: '---\ntitle: FirstPublication\ntime: 2026/10/30\n---\n[](content://RenamedTarget)', base_namespace_revision: 0, base_title_revision: new_head.title_revision }
    const new_saved = await command_draft(a, new_text)
    const first_publish: DraftCommand = { id: draft.id, lease: new_lease, kind: 'publish', seq: 2, expected_revision: new_saved.snapshot!.draft_revision, base_namespace_revision: 0, base_title_revision: new_saved.snapshot!.title_revision }
    const first_result = await command_draft(a, first_publish)
    assert(first_result.receipt!.ok)
    assert.equal(first_result.snapshot!.id, draft.id)
    assert(first_result.snapshot!.story_id)
    assert.equal((await command_draft(a, first_publish)).receipt!.story_id, first_result.receipt!.story_id)
    const [first_count] = await db.execute<RowDataPacket[]>('SELECT COUNT(*) AS n FROM content_stories WHERE title = \'FirstPublication\'')
    assert.equal(Number(first_count[0]!.n), 1)
    check('first publication retains draft identity and a repeated publish creates exactly one main')
    const again = await acquire_draft(owner, { id: initial.id, expected_epoch: lease.epoch, page_id: new_page, token: new_token })
    assert(again.snapshot!.owned)
    lease = { epoch: again.snapshot!.lease_epoch, page_id: new_page, token: new_token }
    seq = 0
    const renamed_text = valid.replace('RenamedTarget', 'OtherName').replace('old/file.txt', 'new/file.txt')
    const renamed_saved = await send('sync', { markdown: renamed_text })
    assert((await send('publish', { expected_revision: renamed_saved.result.snapshot!.draft_revision })).result.receipt!.ok)
    assert((await get_draft(a, { id: draft.id })).snapshot!.markdown.includes('content://OtherName'))
    assert((await send('delete')).result.receipt!.ok)
    await assert.rejects(get_draft(owner, { id: initial.id }), (error: unknown) => (error as { statusCode?: number }).statusCode === 404)
    assert((await get_draft(a, { id: draft.id })).snapshot!.markdown.includes('content://OtherName'))
    check('title replay updates both published representations; delete cascades its draft and preserves dangling references elsewhere')
    await db.execute('UPDATE users SET is_admin = 0, permissions = JSON_ARRAY() WHERE id = ?', [owner.id])
    await assert.rejects(get_draft(owner, { id: draft.id }), (error: unknown) => (error as { statusCode?: number }).statusCode === 403)
    for (const permission of [{ field: 'content_manage', level: 'full' }, { field: 'content_private', level: 'read' }]) {
      await db.execute('UPDATE users SET permissions = CAST(? AS JSON) WHERE id = ?', [JSON.stringify([permission]), owner.id])
      await assert.rejects(get_draft(owner, { id: draft.id }), (error: unknown) => (error as { statusCode?: number }).statusCode === 403)
    }
    await db.execute('UPDATE users SET permissions = CAST(? AS JSON) WHERE id = ?', [JSON.stringify([{ field: 'content_manage', level: 'full' }, { field: 'content_private', level: 'read' }]), owner.id])
    assert((await get_draft(owner, { id: draft.id })).snapshot)
    await db.execute('UPDATE users SET is_admin = 1 WHERE id = ?', [owner.id])
    check('current database permissions override stale incoming admin claims')
    const token_lock = await db.getConnection()
    const witness = await db.getConnection()
    try {
      await token_lock.beginTransaction()
      await token_lock.execute('UPDATE user_login_session_tokens SET expires_at = TIMESTAMPADD(SECOND, 2, CURRENT_TIMESTAMP) WHERE id = ?', [owner.token_generation_id!])
      const blocked_read = get_draft(owner, { id: draft.id })
      const rejected = assert.rejects(blocked_read, (error: unknown) => (error as { statusCode?: number }).statusCode === 401)
      const stale_clock = witness.execute<RowDataPacket[]>('SELECT expires_at > CURRENT_TIMESTAMP(3) AS valid FROM user_login_session_tokens WHERE id = ? FOR SHARE', [owner.token_generation_id!])
      await delay(2200)
      await token_lock.commit()
      await rejected
      const [[old_decision]] = await stale_clock
      assert.equal(Number(old_decision!.valid), 1, 'The old statement-start clock would have accepted the expired token')
    }
    finally {
      await token_lock.rollback()
      token_lock.release()
      witness.release()
      await db.execute('UPDATE user_login_session_tokens SET expires_at = TIMESTAMPADD(DAY, 1, CURRENT_TIMESTAMP) WHERE id = ?', [owner.token_generation_id!])
    }
    check('draft reads reject a token that expires while its authorization row lock is queued')
    const [events] = await db.execute<RowDataPacket[]>('SELECT resource, payload FROM content_sync_outbox WHERE resource LIKE \'content_draft%\'')
    assert(events.length > 0)
    for (const event of events) {
      const payload = typeof event.payload === 'string' ? JSON.parse(event.payload) : event.payload
      assert.equal(payload.resource, event.resource)
      assert(! JSON.stringify(event).includes(initial.id))
      assert(! JSON.stringify(event).includes(token_a))
    }
    check('outbox topic and payload use the same opaque resource and contain no draft id/body/token')
    const { verify_draft_concurrency } = await import('./cloud-draft-concurrency')
    await verify_draft_concurrency(owner)
    if (process.argv.includes('--mqtt')) {
      const { verify_draft_mqtt } = await import('./cloud-draft-mqtt')
      await verify_draft_mqtt(owner)
    }
    if (process.argv.includes('--capacity')) {
      const { verify_draft_capacity } = await import('./cloud-draft-capacity')
      await verify_draft_capacity(owner)
    }
    console.log(`cloud-draft QA passed: ${checks} contracts in a disposable database`)
  }
  finally {
    await pool?.end()
    if (created) {
      assert.match(name, /^stupig_cloud_draft_qa_[a-f0-9]{32}$/)
      await root.query(`DROP DATABASE \`${name}\``)
    }
    await root.end()
  }
}

await verify()
