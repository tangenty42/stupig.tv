import type { create_aliyun_oss } from '@server/lib/aliyun-oss'
import type { ImageAccessRow } from '@server/services/content/attachment-access.service'
import type { AuthUser } from '@server/types/auth'
import type { DraftCommand, DraftLease } from '@shared/types/content-draft'
import type { RowDataPacket } from 'mysql2/promise'
import assert from 'node:assert/strict'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { Readable } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import { runtime_config } from '@config/loader'
import { db } from '@server/lib/db'
import { create_esa } from '@server/lib/esa'
import { resolve_attachment_delivery } from '@server/services/content/attachment-access.service'
import { get_attachment_workspace } from '@server/services/content/attachment-workspace.service'
import { acquire_draft, command_draft, create_draft, get_draft } from '@server/services/content/draft.service'
import { authorize_edge_read } from '@server/services/content/edge-read.service'
import { create_image_jobs } from '@server/services/content/image-job.service'
import { with_namespace_change } from '@server/services/content/reference-history.service'
import { append_reference_journal } from '@server/services/content/reference-journal.repository'
import { create_content_sync_dispatcher } from '@server/services/content/sync-outbox.service'
import { ensure_workspace_folders } from '@server/services/content/workspace.repository'
import { settings } from '@shared/settings'
import sharp from 'sharp'

/** A bounded local workload, not a production capacity claim. */
export async function verify_draft_capacity(actor: AuthUser) {
  const [[database]] = await db.query<RowDataPacket[]>('SELECT DATABASE() AS name')
  assert.match(String(database!.name), /^stupig_cloud_draft_qa_[a-f0-9]{32}$/)
  const id = () => randomBytes(16).toString('hex')
  async function editor(title: string) {
    const head = (await create_draft(actor, id())).snapshot!
    const page_id = id()
    const token = randomBytes(32).toString('hex')
    const acquired = (await acquire_draft(actor, { id: head.id, expected_epoch: 0, page_id, token })).snapshot!
    const lease: DraftLease = { page_id, token, epoch: acquired.lease_epoch }
    let seq = 0
    let current = acquired
    async function send(kind: DraftCommand['kind'], text?: string, base_title_revision = current.title_revision) {
      const result = await command_draft(actor, { id: head.id, lease, seq: ++ seq, kind, base_namespace_revision: current.namespace_revision, base_title_revision,
        ... (text === undefined ? {} : { markdown: text }), ... (kind === 'publish' ? { expected_revision: current.draft_revision } : {}) })
      assert(result.receipt?.ok, result.receipt?.message ?? 'Capacity command was rejected')
      current = result.snapshot!
      return current
    }
    const body = `---\ntitle: ${title}\ntime: 2026/10/30\n---\n`
    await send('sync', body)
    const main = await send('publish')
    return { send, body, story: main.story_id!, draft: main.id }
  }
  let workspace!: Awaited<ReturnType<typeof editor>>
  for (const depth of [0, 8]) {
    workspace = await editor(`CapacityWorkspace${depth}`)
    const path = depth ? 'a/b/c/d/e/f/g/h' : ''
    const connection = await db.getConnection()
    let parent: number
    try {
      parent = await ensure_workspace_folders(connection, workspace.story, path)
    }
    finally { connection.release() }
    let inserted = 0
    for (const count of [100, 1000, 10000]) {
      while (inserted < count) {
        const size = Math.min(500, count - inserted)
        const values = Array.from({ length: size }, (_, offset) => {
          const name = `file${inserted + offset}.txt`
          return [workspace.story, parent, name, name, path ? `${path}/${name}` : name, 0, `content/att/qa/${workspace.story}/${name}`, 'v1', 'aliyun']
        })
        await db.query('INSERT INTO content_story_attachments (story_id,parent_id,name,name_key,file_name,is_folder,object_key,version,storage_provider) VALUES ?', [values])
        inserted += size
      }
      const times: number[] = []
      let bytes = 0
      for (let sample = 0; sample < 3; sample ++) {
        const started = performance.now()
        const result = await get_attachment_workspace(workspace.story, actor)
        times.push(performance.now() - started)
        assert.equal(result.attachments.length, count)
        bytes = Buffer.byteLength(JSON.stringify(result))
      }
      console.log(`cloud-draft capacity: workspace files=${count}, depth=${depth}, max_ms=${Math.max(... times).toFixed(1)}, response_bytes=${bytes}`)
    }
  }
  // Model already-consumed unrelated history, including a 250-row batch, as
  // the retention browser fixtures do. Future input must replay all 200 batches.
  const history = await db.getConnection()
  try {
    await history.beginTransaction()
    const [[title]] = await history.query<RowDataPacket[]>('SELECT revision FROM content_title_namespace WHERE id = 1 FOR UPDATE')
    const [[scope]] = await history.execute<RowDataPacket[]>('SELECT namespace_revision FROM content_stories WHERE id = ? FOR UPDATE', [workspace.story])
    for (const [scope_id, base] of [[0, Number(title!.revision)], [workspace.story, Number(scope!.namespace_revision)]]) {
      for (let batch = 1; batch <= 200; batch ++) {
        await append_reference_journal(history, scope_id!, base! + batch, Array.from({ length: batch === 2 ? 250 : 1 }, (_, index) => ({
          node_id: index + 1, from: `${scope_id ? 'att' : 'content'}://unused${batch}-${index}`, to: `${scope_id ? 'att' : 'content'}://moved${batch}-${index}`,
        })))
      }
    }
    await history.execute('UPDATE content_title_namespace SET revision = revision + 200 WHERE id = 1')
    await history.execute('UPDATE content_stories SET namespace_revision = namespace_revision + 200 WHERE id = ?', [workspace.story])
    await history.execute('UPDATE content_story_drafts SET title_revision = title_revision + 200, draft_revision = draft_revision + 200')
    await history.execute('UPDATE content_story_drafts SET namespace_revision = namespace_revision + 200 WHERE story_id = ?', [workspace.story])
    await history.commit()
  }
  catch (error) {
    await history.rollback()
    throw error
  }
  finally { history.release() }
  const objects = new Map<string, Buffer>()
  const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
  const storage = {
    head_object: async (key: string) => ({ size: objects.get(key)!.length, etag: digest(objects.get(key)!), version_id: key }),
    get_object_access: async () => 'private',
    get_object_stream: async (key: string) => ({ stream: Readable.from([objects.get(key)!]), size: objects.get(key)!.length }),
    put_object: async (key: string, bytes: Uint8Array) => {
      objects.set(key, Buffer.from(bytes))
      return { etag: digest(bytes), version_id: key }
    },
    copy_object: async (source: string, target: string) => storage.put_object(target, objects.get(source)!),
  }
  const image_config = runtime_config().app.contentImages
  const images = create_image_jobs(db, storage as unknown as ReturnType<typeof create_aliyun_oss>, image_config.leaseSeconds, image_config.heartbeatSeconds)
  const image_jobs: string[] = []
  for (let image = 0; image < 2; image ++) {
    const key = `content/att/staging/${id()}/${id()}`
    const bytes = await sharp(randomBytes(512 * 512 * 3), { raw: { width: 512, height: 512, channels: 3 } }).png().toBuffer()
    objects.set(key, bytes)
    const job = await images.enqueue(randomUUID(), { scope_id: workspace.story, actor_id: actor.id, mode: 'upload', source: null, is_private: false,
      original_name: 'capacity.png', original_mime: 'image/png', profile_version: image_config.profileVersion, profile: image_config.profile,
      input: { key, size: bytes.length, etag: digest(bytes), version_id: key, sha256: digest(bytes) } })
    image_jobs.push(job.id)
  }
  runtime_config().aliyun.esa = { baseUrl: 'https://capacity.invalid', authKey: randomBytes(32).toString('hex'), urlTtlSeconds: 300 }
  const [[file]] = await db.execute<(RowDataPacket & ImageAccessRow)[]>('SELECT * FROM content_story_attachments WHERE story_id = ? AND is_folder = 0 ORDER BY id DESC LIMIT 1', [workspace.story])
  const delivery = await resolve_attachment_delivery(file!, 'auto', actor)
  const read_url = create_esa().signed_read_url(delivery.key, 300, 'GET', undefined, 'inline', delivery.grant)
  assert(await authorize_edge_read({ url: read_url, method: 'GET', nonce: randomUUID() }))
  // Publishing advances all draft revisions; prepare writers in sequence so
  // setup itself does not intentionally publish a stale confirmed snapshot.
  const writers = [await editor('CapacityWriterA'), await editor('CapacityWriterB')]
  const target = await editor('CapacityTitleTarget')
  const [[window]] = await db.query<RowDataPacket[]>('SELECT revision_floor FROM content_title_namespace WHERE id = 1')
  const input_baseline = Number(window!.revision_floor) + 1
  const [[title_head]] = await db.query<RowDataPacket[]>('SELECT revision FROM content_title_namespace WHERE id = 1')
  const references = Array.from({ length: 100 }, () => [id(), `[target](content://CapacityTitleTarget)\n${'x'.repeat(64 * 1024)}`, title_head!.revision, actor.id])
  await db.query('INSERT INTO content_story_drafts (id,markdown,title_revision,created_by) VALUES ?', [references])
  const saves: number[] = []
  const renewals: number[] = []
  const connection_waits: number[] = []
  const get_connection = db.getConnection.bind(db)
  let queue_events = 0
  const enqueued = () => {
    queue_events ++
  }
  db.on('enqueue', enqueued)
  db.getConnection = async () => {
    const started = performance.now()
    const connection = await get_connection()
    connection_waits.push(performance.now() - started)
    return connection
  }
  // The actual dispatcher runs against real SQL; only its remote ACK is a
  // bounded local boundary. Real broker permissions/delivery are separate QA.
  let deliveries = 0
  const dispatch = create_content_sync_dispatcher(db, async () => {
    await delay(2)
    deliveries ++
  }, { ... runtime_config().app.contentSync, enabled: true, scanLimit: 25 })
  const pending = async () => {
    const [[row]] = await db.query<RowDataPacket[]>('SELECT COUNT(*) AS n, COALESCE(TIMESTAMPDIFF(MICROSECOND, MIN(created_at), CURRENT_TIMESTAMP(3)) / 1000, 0) AS age FROM content_sync_outbox')
    return { n: Number(row!.n), age: Number(row!.age) }
  }
  while ((await pending()).n) await dispatch()
  let running = true
  let lock_peak = 0
  let outbox_peak = 0
  let outbox_age = 0
  const monitor = (async () => {
    // eslint-disable-next-line no-unmodified-loop-condition -- The enclosing workload stops this asynchronous monitor in finally.
    while (running) {
      const [[locks]] = await db.execute<RowDataPacket[]>(`SELECT COUNT(*) AS n FROM performance_schema.data_lock_waits w
        INNER JOIN performance_schema.data_locks l ON l.ENGINE_LOCK_ID = w.REQUESTING_ENGINE_LOCK_ID AND l.ENGINE = w.ENGINE WHERE l.OBJECT_SCHEMA = ?`, [database!.name])
      lock_peak = Math.max(lock_peak, Number(locks!.n))
      const queue = await pending()
      outbox_peak = Math.max(outbox_peak, queue.n)
      outbox_age = Math.max(outbox_age, queue.age)
      await dispatch()
      await delay(20)
    }
  })()
  const background = Array.from({ length: 4 }, async () => {
    for (let job = 0; job < 40; job ++)
      await db.query('SELECT SLEEP(0.01)')
  })
  const mutations = writers.map(async (writer) => {
    for (let command = 0; command < 40; command ++) {
      const renewal = command % 2 === 0
      const started = performance.now()
      const bytes = [4096, 65536, 262144][command % 3]!
      await writer.send('sync', renewal ? undefined : `${writer.body}[target](content://CapacityTitleTarget)\n${'x'.repeat(bytes)}${command}`, renewal ? undefined : input_baseline)
      ;(renewal ? renewals : saves).push(performance.now() - started)
    }
  })
  const rename = (async () => {
    await target.send('sync', target.body.replace('CapacityTitleTarget', 'CapacityTitleRenamed'))
    const started = performance.now()
    await target.send('publish')
    console.log(`cloud-draft capacity: title_publish_ms=${(performance.now() - started).toFixed(1)}, referenced_drafts=100, body_bytes=65536`)
    const [[updated]] = await db.query<RowDataPacket[]>('SELECT COUNT(*) AS n FROM content_story_drafts WHERE markdown LIKE ?', ['[target](content://CapacityTitleRenamed)%'])
    assert.equal(Number(updated!.n), 100)
  })()
  const publication = (async () => {
    const started = performance.now()
    await with_namespace_change(workspace.story, async (connection) => {
      const [files] = await connection.execute<RowDataPacket[]>('SELECT id FROM content_story_attachments WHERE story_id = ? AND is_folder = 0 ORDER BY id LIMIT 250', [workspace.story])
      await connection.execute(`UPDATE content_story_attachments SET file_name = CONCAT('a/b/c/d/e/f/g/h/moved-', name), name_key = CONCAT('moved-', name_key), name = CONCAT('moved-', name), node_revision = node_revision + 1 WHERE id IN (${files.map(() => '?').join(',')})`, files.map(row => row.id))
    })
    console.log(`cloud-draft capacity: namespace_publication_ms=${(performance.now() - started).toFixed(1)}, batch_rows=250, scope_files=10000, history_batches=200`)
  })()
  const reads = (async () => {
    for (let request = 0; request < 40; request ++)
      assert(await authorize_edge_read({ url: read_url, method: 'GET', nonce: randomUUID() }))
  })()
  try {
    await Promise.all([... background, ... mutations, rename, publication, reads, ... image_jobs.map(job => images.run(job, actor.id))])
  }
  finally {
    running = false
    await monitor
    db.getConnection = get_connection
    db.off('enqueue', enqueued)
  }
  while ((await pending()).n) await dispatch()
  const [[image_count]] = await db.query<RowDataPacket[]>('SELECT COUNT(*) AS n FROM content_image_jobs WHERE status = \'ready\'')
  assert.equal(Number(image_count!.n), 2)
  console.log(`cloud-draft capacity: images=2, pixels=512x512, content=random_RGB, avif_effort=${image_config.profile.avifEffort}`)
  console.log(`cloud-draft capacity: pool_wait_max_ms=${Math.max(... connection_waits).toFixed(1)}, enqueue_events=${queue_events}, lock_wait_peak=${lock_peak}, outbox_peak=${outbox_peak}, oldest_outbox_ms=${outbox_age.toFixed(1)}, delivered=${deliveries}, final_outbox=0, ready_images=2, authorized_reads=40`)
  for (const [kind, values] of [['save', saves], ['renew', renewals]] as const) {
    values.sort((a, b) => a - b)
    const p99 = values[Math.ceil(values.length * 0.99) - 1]!
    assert(p99 < settings.app.content.draft.requestTimeoutMs, `${kind} P99 exceeded T`)
    console.log(`cloud-draft capacity: ${kind} samples=${values.length}, writers=2, background_slots=4, body_bytes=4096/65536/262144, p99_ms=${p99.toFixed(1)}`)
  }
  // Saturate the actual ten-connection pool, expire a queued writer, then free
  // capacity. It must reject the old write rather than renew from ingress time.
  const before = (await get_draft(actor, { id: writers[0]!.draft })).snapshot!.markdown
  const held: Awaited<ReturnType<typeof db.getConnection>>[] = []
  let rejected: Promise<void>
  try {
    for (let index = 0; index < 10; index ++)
      held.push(await db.getConnection())
    const blocked = writers[0]!.send('sync', 'stale overloaded input')
    rejected = assert.rejects(blocked, /编辑权已变更/)
    await delay(50)
    await held[0]!.execute('UPDATE content_story_drafts SET lease_until = TIMESTAMPADD(SECOND, -1, CURRENT_TIMESTAMP(3)) WHERE id = ?', [writers[0]!.draft])
  }
  finally {
    for (const connection of held) connection.release()
  }
  await rejected
  assert.equal((await get_draft(actor, { id: writers[0]!.draft })).snapshot!.markdown, before)
  console.log('cloud-draft capacity: saturated pool resumes; expired queued write rejected without text change')
}
