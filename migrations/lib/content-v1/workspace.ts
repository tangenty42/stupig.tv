import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import type { MigrationContext, MigrationDatabase, MigrationReadContext } from '../../../scripts/migration/contract'
import type { Converted, ImageOptions } from './images'
import type { Identity } from './objects'
import type { Node, ScopePlan, Story } from './plan'
import { load_aliyun_oss_config, load_content_migration_options, load_migration_image_profile } from '@config/loader'
import { require_adoptable_objects } from '@server/services/content/object-adoption.service'
import { enqueue_workspace_change } from '@server/services/content/workspace-sync.service'
import { parse_migration_ref } from '@shared/content-reference'
import sharp from 'sharp'
import { convert_node, image_metadata } from './images'
import { verify_object } from './objects'
import { attachment_references, canonical, digest, json, plan_scope, require_reference_identity, rewrite_markdown, snapshot_fingerprint, validate_titles } from './plan'
import { pending_work, require_quiet } from './preflight'

interface ScopeRow extends RowDataPacket {
  scope_id: number
  source_snapshot: unknown
  source_fingerprint: string
  destination_fingerprint: string
  adopted_fingerprint: string | null
  plan: ScopePlan | string
  state: 'copying' | 'adopted'
}
interface Snapshot { story: Story | null, nodes: Node[] }
async function snapshot(db: MigrationDatabase, scope: number, lock = false): Promise<Snapshot> {
  const suffix = lock ? ' FOR UPDATE' : ''
  const [[story]] = await db.query<(Story & RowDataPacket)[]>(`SELECT * FROM content_stories WHERE id=?${suffix}`, [scope])
  const [nodes] = await db.query<(Node & RowDataPacket)[]>(`SELECT * FROM content_story_attachments WHERE scope_id=? ORDER BY id${suffix}`, [scope])
  return { story: story ?? null, nodes }
}
function restore_snapshot(value: unknown) {
  const result = json<Snapshot>(value as string)
  for (const row of result.nodes) {
    for (const key of ['lqip_jpeg', 'redacted_lqip_jpeg'] as const) {
      if (row[key] && ! Buffer.isBuffer(row[key]))
        row[key] = Buffer.from((row[key] as unknown as { data: number[] }).data)
    }
  }
  return result
}
const fingerprint = (value: Snapshot) => snapshot_fingerprint(value.story, value.nodes)
const object_keys = (row: Node) => [... new Set([row.object_key, row.original_key, row.avif_key, row.jpeg_key, row.redacted_avif_key, row.redacted_jpeg_key].filter((key): key is string => !! key))]
async function scopes(db: MigrationDatabase) {
  const [stories] = await db.query<(Story & RowDataPacket)[]>('SELECT * FROM content_stories ORDER BY id')
  const [orphans] = await db.query<RowDataPacket[]>('SELECT id FROM content_story_attachments WHERE scope_id=0 LIMIT 1')
  const [missing] = await db.query<RowDataPacket[]>('SELECT a.id FROM content_story_attachments a LEFT JOIN content_stories s ON s.id=a.story_id WHERE a.story_id IS NOT NULL AND s.id IS NULL LIMIT 1')
  if (missing.length)
    throw new Error('migration_attachment_story_missing')
  return { stories, ids: [... (orphans.length ? [0] : []), ... stories.map(story => Number(story.id))] }
}

export async function workspace_plan(ctx: MigrationReadContext) {
  const { stories, ids } = await scopes(ctx.db)
  const work = await pending_work(ctx.db)
  let changed = 0
  let objects = 0
  let issues = validate_titles(stories).length
  let redacted = 0
  let unresolved = 0
  const details: { scope: number, node?: number, code: string }[] = validate_titles(stories).map(issue => ({ scope: issue.id, code: issue.code }))
  for (const id of ids) {
    const current = await snapshot(ctx.db, id)
    const plan = plan_scope(current.nodes)
    issues += plan.issues.length
    details.push(... plan.issues.map(issue => ({ scope: id, node: issue.id, code: issue.code })))
    changed += Number(plan.changed)
    objects += plan.needs_objects.length
    redacted += Object.keys(plan.twins).length
    if (current.story)
      unresolved += attachment_references(current.story.markdown).filter(path => ! current.nodes.some(row => row.file_name === path)).length
  }
  return { summary: 'Content 目录、存储、图片版本及删减版切换；保留源对象与回滚快照', counts: { scopes: ids.length, changed, objects, redacted, issues, unresolved, ... work }, issues: details, blocked: issues > 0 || Object.values(work).some(Boolean) }
}

/** Storage and codec identities, not credentials. A resume must keep its exact destination/profile. */
function destination(needs_objects: boolean) {
  if (! needs_objects)
    return { hash: digest('namespace-only-v1'), options: null }
  const config = load_aliyun_oss_config()
  if (! config)
    throw new Error('migration_destination_missing')
  const options: ImageOptions = { ... load_migration_image_profile(), part_size: load_content_migration_options().partSizeMb * 1024 * 1024, codec: canonical(sharp.versions) }
  return { hash: digest(canonical({ bucket: config.bucket, endpoint: config.endpoint, region: config.region, options })), options }
}

async function existing_objects(ctx: MigrationContext, rows: Node[]) {
  const storage = await ctx.oss()
  for (const row of rows.filter(row => ! row.is_folder && row.storage_provider === 'aliyun' && ! row.encryption_key)) {
    const metadata = row.image_metadata ? json<Record<string, unknown>>(row.image_metadata as string) : null
    const redacted = row.redacted_metadata ? json<Record<string, unknown>>(row.redacted_metadata as string) : null
    for (const key of object_keys(row)) {
      const identity = [metadata?.original, metadata?.avif, metadata?.jpeg, redacted?.avif, redacted?.jpeg].find(value => value && (value as Identity).key === key) as Identity | undefined
      if (identity?.sha256) {
        await verify_object(ctx, identity)
      }
      else {
        const head = await storage.head_object(key)
        if (await storage.get_object_access(key) !== 'private')
          throw new Error('migration_existing_object_not_private')
        if (key === row.object_key && (head.etag !== row.version || head.size !== Number(row.file_size) || (row.oss_version_id && head.version_id !== row.oss_version_id)))
          throw new Error('migration_existing_object_changed')
      }
    }
  }
}

async function adopt(ctx: MigrationContext, scope: number, source: Snapshot, plan: ScopePlan, converted: Map<number, Converted>, redacted: Map<number, Converted>, options: ImageOptions | null) {
  await ctx.transaction(async (db) => {
    const current = await snapshot(db, scope, true)
    if (fingerprint(current) !== fingerprint(source))
      throw new Error('migration_namespace_changed')
    await require_quiet(db)
    const keys = [... converted.values(), ... redacted.values()].flatMap(result => [result.main.key, result.original?.key, result.avif?.key, result.jpeg?.key])
    await require_adoptable_objects(db, keys)
    // Release only the comparison keys, inside the same transaction; no transient namespace leaks.
    await db.execute('UPDATE content_story_attachments SET name_key=NULL, updated_at=updated_at WHERE scope_id=?', [scope])
    const ids = new Map<string, number>()
    for (const node of plan.nodes) {
      const parent = node.parent === null ? 0 : ids.get(node.parent)
      if (parent === undefined)
        throw new Error('migration_parent_missing')
      let id = node.id
      if (id === null) {
        const [inserted] = await db.execute<ResultSetHeader>(`INSERT INTO content_story_attachments(story_id,is_folder,file_name,version,parent_id,name,name_key,is_private,storage_provider,storage_bucket)
          VALUES (?,1,?,?,?,?,?,?,'aliyun','private')`, [scope || null, node.path, digest(`folder:${scope}:${node.path}`).slice(0, 32), parent, node.name, node.key, Number(node.private)])
        id = inserted.insertId
      }
      else {
        await db.execute(`UPDATE content_story_attachments SET file_name=?,parent_id=?,name=?,name_key=?,is_private=?,node_revision=node_revision+1,read_revision=read_revision+1,
          storage_provider=IF(is_folder=1,'aliyun',storage_provider),storage_bucket=IF(is_folder=1,'private',storage_bucket),updated_at=updated_at WHERE id=?`, [node.path, parent, node.name, node.key, Number(node.private), id])
      }
      ids.set(node.path, id)
      const result = converted.get(id)
      const row = source.nodes.find(row => Number(row.id) === id)
      if (result && row) {
        await db.execute(`UPDATE content_story_attachments SET object_key=?,version=?,oss_version_id=?,file_size=?,mime_type=?,storage_provider='aliyun',storage_bucket='private',encryption_key=NULL,
          original_key=?,avif_key=?,jpeg_key=?,parent_avif_key=NULL,image_revision=?,is_edited=0,image_metadata=CAST(? AS JSON),lqip_jpeg=?,updated_at=updated_at WHERE id=?`,
        [result.main.key, result.main.etag, result.main.version_id, result.main.size, result.mime, result.original?.key ?? null, result.avif?.key ?? null, result.jpeg?.key ?? null, result.avif ? Math.max(1, Number(row.image_revision)) : 0,
          result.avif ? JSON.stringify(image_metadata(result, row, options!)) : null, result.lqip, id])
      }
      const public_image = redacted.get(id)
      if (public_image && row) {
        await db.execute(`UPDATE content_story_attachments SET redacted_avif_key=?,redacted_jpeg_key=?,redacted_revision=redacted_revision+1,redacted_metadata=CAST(? AS JSON),redacted_lqip_jpeg=?,updated_at=updated_at WHERE id=?`,
          [public_image.avif!.key, public_image.jpeg!.key, JSON.stringify(image_metadata(public_image, row, options!)), public_image.lqip, id])
      }
    }
    if (source.story) {
      const ref = parse_migration_ref(source.story.cover)
      const cover_path = ref && 'path' in ref ? plan.paths[ref.path] : undefined
      const cover = cover_path === undefined ? source.story.cover : cover_path
      const cover_row = plan.nodes.find(node => node.path === cover && ! node.folder)
      const cover_id = cover_row ? ids.get(cover_row.path) : undefined
      const version = cover_id ? converted.get(cover_id)?.main.etag ?? source.nodes.find(row => Number(row.id) === cover_id)?.version ?? null : source.story.cover_version
      await db.execute('UPDATE content_stories SET markdown=?,cover=?,cover_version=?,namespace_revision=namespace_revision+1,namespace_floor=namespace_revision,updated_at=updated_at WHERE id=?', [rewrite_markdown(source.story.markdown, plan.paths), cover, version, scope])
      await enqueue_workspace_change(db, scope, { attachments: true, story: true, stories: true })
    }
    const adopted = await snapshot(db, scope)
    if (source.story && adopted.story)
      require_reference_identity(source.story.markdown, adopted.story.markdown, source.nodes, adopted.nodes)
    await db.execute('UPDATE content_migration_scopes SET state=\'adopted\',adopted_at=CURRENT_TIMESTAMP,adopted_fingerprint=? WHERE scope_id=? AND state=\'copying\'', [fingerprint(adopted), scope])
    await ctx.checkpoint.save({ last_scope: scope })
  })
}

export async function migrate_workspace(ctx: MigrationContext) {
  const report = await workspace_plan(ctx)
  if (report.blocked)
    throw new Error('content_migration_preflight_blocked')
  const { ids } = await scopes(ctx.db)
  for (const scope of ids) {
    ctx.signal.throwIfAborted()
    const [[saved]] = await ctx.db.query<ScopeRow[]>('SELECT * FROM content_migration_scopes WHERE scope_id=?', [scope])
    const current = await snapshot(ctx.db, scope)
    if (saved?.state === 'adopted') {
      if (fingerprint(current) !== saved.adopted_fingerprint)
        throw new Error('migration_adopted_scope_changed')
      continue
    }
    const source = saved ? restore_snapshot(saved.source_snapshot) : current
    const plan = saved ? json<ScopePlan>(saved.plan) : plan_scope(source.nodes)
    if (! plan.changed)
      continue
    if (plan.issues.length || fingerprint(source) !== fingerprint(current))
      throw new Error('migration_source_snapshot_changed')
    const target = destination(plan.needs_objects.length > 0)
    if (saved && target.hash !== saved.destination_fingerprint)
      throw new Error('migration_destination_changed')
    if (! saved) {
      await ctx.transaction(async (db) => {
        if (fingerprint(await snapshot(db, scope, true)) !== fingerprint(source))
          throw new Error('migration_namespace_changed')
        const keys = source.nodes.filter(row => row.storage_provider === 'aliyun').flatMap(object_keys)
        await require_adoptable_objects(db, keys)
        await db.execute('INSERT INTO content_migration_scopes(scope_id,source_snapshot,source_fingerprint,destination_fingerprint,plan) VALUES (?,CAST(? AS JSON),?,?,CAST(? AS JSON))', [scope, canonical(source), fingerprint(source), target.hash, JSON.stringify(plan)])
        for (const key of [... new Set(keys)]) await db.execute('INSERT IGNORE INTO content_migration_pins(object_key,scope_id) VALUES (?,?)', [key, scope])
      })
    }
    const converted = new Map<number, Converted>()
    const redacted = new Map<number, Converted>()
    for (const id of plan.needs_objects) {
      const row = source.nodes.find(row => Number(row.id) === id)!
      converted.set(id, await convert_node(ctx, scope, row, target.options!))
      const twin_id = plan.twins[String(id)]
      if (twin_id !== undefined) {
        const twin = source.nodes.find(row => Number(row.id) === twin_id)!
        const result = await convert_node(ctx, scope, { ... twin, id }, target.options!, 'redacted-')
        if (! result.avif || ! result.jpeg)
          throw new Error('migration_redacted_not_static_image')
        redacted.set(id, result)
      }
    }
    if (source.nodes.some(row => ! row.is_folder && row.storage_provider === 'aliyun' && ! row.encryption_key && ! plan.needs_objects.includes(Number(row.id))))
      await existing_objects(ctx, source.nodes.filter(row => ! plan.needs_objects.includes(Number(row.id))))
    await adopt(ctx, scope, source, plan, converted, redacted, target.options)
  }
  // Re-read every target, including a resumed adopted scope, before the runner's verify receipt.
  const [objects] = await ctx.db.query<RowDataPacket[]>('SELECT result FROM content_migration_objects WHERE state=\'verified\'')
  for (const row of objects) await verify_object(ctx, json<Identity>(row.result))
}

export async function verify_workspace(ctx: MigrationReadContext) {
  if ((await workspace_plan(ctx)).blocked)
    return false
  const { ids } = await scopes(ctx.db)
  for (const scope of ids) {
    const current = await snapshot(ctx.db, scope)
    if (plan_scope(current.nodes).changed)
      return false
    const [[row]] = await ctx.db.query<ScopeRow[]>('SELECT * FROM content_migration_scopes WHERE scope_id=?', [scope])
    if (row && (row.state !== 'adopted' || row.adopted_fingerprint !== fingerprint(current)))
      return false
  }
  const [[pending]] = await ctx.db.query<RowDataPacket[]>('SELECT COUNT(*) AS n FROM content_migration_objects WHERE state<>\'verified\'')
  return Number(pending!.n) === 0
}
