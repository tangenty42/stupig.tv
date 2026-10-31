import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  story: { id: 1, title: '本文', markdown: '---\ntitle: 本文\ntime: 2026/10/14\ncover: att://old.png\n---\n[](att://old.png)', revision: 7, namespace_revision: 0, namespace_floor: 0, cover: 'old.png', cover_version: 'v1' },
  nodes: [{ id: 11, file_name: 'old.png', is_folder: 0, object_key: 'key', version: 'v1' }],
  journals: [] as { scope_id: number, revision: number, changes: unknown }[],
  other_stories: [] as { id: number, markdown: string }[],
  title_revision: 0,
  title_floor: 0,
  committed: 0,
  rolled_back: 0,
  released: 0,
  events: [] as unknown[],
  writes: [] as string[],
  locks: [] as string[],
}))

vi.mock('@server/lib/db', () => {
  const execute = vi.fn(async (sql: string, params: unknown[] = []) => {
    if (sql.includes('FROM content_story_drafts'))
      return [[]]
    if (sql.includes('FOR UPDATE') || sql.includes('FOR SHARE'))
      state.locks.push(sql)
    if (! sql.startsWith('SELECT'))
      state.writes.push(sql)
    if (sql.startsWith('INSERT INTO content_sync_outbox')) {
      state.events.push(JSON.parse(String(params[2])))
      return [{ affectedRows: 1 }]
    }
    if (sql.includes('FROM content_title_namespace'))
      return [[{ revision: state.title_revision, revision_floor: state.title_floor }]]
    if (sql.startsWith('SELECT DISTINCT revision'))
      return [state.journals.filter(row => row.scope_id === params[0]).sort((a, b) => b.revision - a.revision).slice(Number(params[1]), Number(params[1]) + 1)]
    if (sql.includes('FROM content_reference_journals') && sql.startsWith('SELECT')) {
      return [state.journals.filter(row => row.scope_id === params[0] && row.revision > Number(params[1]) && row.revision <= Number(params[2])).flatMap((row) => {
        const changes = row.changes as { node_id: number, from: string | null, to: string | null, is_folder?: boolean }[]
        const ref = (name: string | null) => name === null ? null : name.includes('://') ? name : `${row.scope_id === 0 ? 'content' : 'att'}://${name}`
        return changes.length
          ? changes.map(change => ({ revision: row.revision, node_id: change.node_id, from_ref: ref(change.from), to_ref: ref(change.to), is_folder: Number(change.is_folder ?? false) }))
          : [{ revision: row.revision, node_id: 0, from_ref: null, to_ref: null, is_folder: 0 }]
      })]
    }
    if (sql.includes('FROM content_story_attachments'))
      return [structuredClone(state.nodes)]
    if (sql.startsWith('SELECT id, title FROM content_stories'))
      return [[{ id: 1, title: state.story.title }, { id: 2, title: '新标题' }].filter(row => ! sql.includes('WHERE id !=') || row.id !== params[0])]
    if (sql.startsWith('SELECT id FROM content_stories'))
      return [[]]
    if (sql.startsWith('SELECT id, markdown FROM content_stories'))
      return [[{ ... state.story }, ... structuredClone(state.other_stories)]]
    if (sql.includes('FROM content_stories'))
      return [[{ ... state.story }]]
    if (sql.startsWith('UPDATE content_stories SET namespace_revision')) {
      state.story.namespace_revision ++
      return [{ affectedRows: 1 }]
    }
    if (sql.startsWith('UPDATE content_stories SET markdown')) {
      const target = params.at(- 1) === 1 ? state.story : state.other_stories.find(row => row.id === params.at(- 1))!
      target.markdown = String(params[0])
      if (sql.includes('cover =')) {
        state.story.cover = String(params[1])
        state.story.cover_version = String(params[2])
      }
      return [{ affectedRows: 1 }]
    }
    if (sql.startsWith('UPDATE content_stories SET title')) {
      state.story.title = String(params[0])
      state.story.markdown = String(params[8])
      state.story.revision ++
      return [{ affectedRows: 1 }]
    }
    if (sql.startsWith('UPDATE content_title_namespace')) {
      state.title_revision ++
      return [{ affectedRows: 1 }]
    }
    if (sql.startsWith('INSERT INTO content_reference_journals')) {
      const changes = []
      for (let index = 0; index < params.length; index += 9) {
        if (params[index + 4] !== null || params[index + 5] !== null)
          changes.push({ node_id: params[index + 3], from: params[index + 4], to: params[index + 5], is_folder: Boolean(params[index + 8]) })
      }
      state.journals.push({ scope_id: Number(params[0]), revision: Number(params[1]), changes })
      return [{ affectedRows: 1 }]
    }
    throw new Error(`Unhandled fixture SQL: ${sql}`)
  })
  return { db: {
    execute,
    getConnection: async () => ({
      execute, beginTransaction: async () => {},
      commit: async () => { state.committed ++ },
      rollback: async () => { state.rolled_back ++ },
      release: () => { state.released ++ },
    }),
  } }
})
vi.mock('@server/lib/sync', () => ({ publish_refresh: (event: unknown) => state.events.push(event), sync_resource: (type: string, id: unknown) => `${type}:${id}` }))
vi.mock('@server/lib/storage', () => ({ delete_object_best_effort: vi.fn() }))

const { with_namespace_change, rewrite_draft_references } = await import('./reference-history.service')
const { begin_namespace_change, finish_namespace_change } = await import('./reference-history.service')
const { db } = await import('@server/lib/db')
const { update_story } = await import('./story.service')

const initial = structuredClone(state)
beforeEach(() => {
  Object.assign(state, structuredClone(initial))
})

describe('transactional reference history', () => {
  it('rewrites every saved title reference without relying on a pre-existing reverse index or a 200-link limit', async () => {
    state.other_stories = [{ id: 3, markdown: `${Array.from({ length: 205 }, (_, index) => `[](content://missing${index})`).join(' ')} [](CONTENT://本文?view=card#top)` }]
    const renamed = state.story.markdown.replace('title: 本文', 'title: 改标题')
    await update_story(1, renamed, 7, true, { base_namespace_revision: 0, base_title_revision: 0 })
    expect(state.other_stories[0]!.markdown).toContain('[](content://改标题?view=card#top)')
    expect(state.other_stories[0]!.markdown).toContain('content://missing204')
    expect(state.events).toContainEqual(expect.objectContaining({ resource: 'content_story:3' }))
    expect(state.journals).toContainEqual(expect.objectContaining({ scope_id: 0, changes: [{ node_id: 1, from: 'content://本文', to: 'content://改标题', is_folder: false }] }))
  })

  it('replays global title history for a not-yet-created story without an attachment scope', async () => {
    state.title_revision = 1
    state.journals = [{ scope_id: 0, revision: 1, changes: [{ node_id: 2, from: 'content://旧标题', to: 'content://新标题' }] }]
    const result = await rewrite_draft_references(0, '[](CONTENT://旧标题#part)', { base_namespace_revision: null, base_title_revision: 0 }, true)
    expect(result).toMatchObject({ markdown: '[](content://新标题#part)', base_namespace_revision: 0, base_title_revision: 1, baseline_unavailable: { namespace: false, title: false } })
    expect(state.writes).toEqual([])
  })

  it('distinguishes namespace-only changes from saved references and list ordering changes', async () => {
    const connection = await db.getConnection()
    const before = await begin_namespace_change(connection, 1)
    expect(await finish_namespace_change(connection, before)).toEqual({})
    state.nodes.push({ id: 12, file_name: 'unused.txt', is_folder: 0, object_key: 'other', version: 'v1' })
    expect(await finish_namespace_change(connection, before)).toEqual({ attachments: true })
    const next = await begin_namespace_change(connection, 1)
    state.nodes[0]!.file_name = 'new.png'
    expect(await finish_namespace_change(connection, next)).toEqual({ attachments: true, story: true, stories: true })
  })

  it.each([
    { is_private: 1 }, { storage_bucket: 'private' }, { storage_provider: 'aliyun', oss_version_id: 'new-version' },
  ])('refreshes a changed cover representation without changing the timestamp policy: %j', async (change) => {
    const connection = await db.getConnection()
    const before = await begin_namespace_change(connection, 1)
    Object.assign(state.nodes[0]!, change)
    expect(await finish_namespace_change(connection, before)).toEqual({ attachments: true, story: true, stories: true })
    expect(state.writes.some(sql => sql.startsWith('UPDATE content_stories SET markdown'))).toBe(false)
  })

  it('refreshes attachment versions even when a command leaves the path unchanged', async () => {
    const connection = await db.getConnection()
    const before = await begin_namespace_change(connection, 1)
    Object.assign(state.nodes[0]!, { node_revision: 2 })
    expect(await finish_namespace_change(connection, before)).toEqual({ attachments: true })
  })

  it('does not refresh a confidential cover when a separate public namesake appears', async () => {
    state.story.cover = 'old.png.good'
    state.nodes[0]!.file_name = 'old.png.good'
    Object.assign(state.nodes[0]!, { is_private: 1 })
    const connection = await db.getConnection()
    const before = await begin_namespace_change(connection, 1)
    state.nodes.push({ id: 12, file_name: 'old.png', is_folder: 0, object_key: 'public-copy', version: 'v2' })
    expect(await finish_namespace_change(connection, before)).toEqual({ attachments: true })
    expect(state.writes.some(sql => sql.startsWith('UPDATE content_stories SET markdown'))).toBe(false)
  })

  it('refreshes a confidential cover when its own redaction is added or removed', async () => {
    state.story.cover = 'old.png.good'
    state.nodes[0]!.file_name = 'old.png.good'
    Object.assign(state.nodes[0]!, { is_private: 1 })
    state.nodes.push({ id: 12, file_name: 'old.png', is_folder: 0, object_key: 'public-copy', version: 'v2' })
    const connection = await db.getConnection()
    const before = await begin_namespace_change(connection, 1)
    Object.assign(state.nodes[0]!, { redacted_avif_key: 'own-avif', redacted_jpeg_key: 'own-jpeg', redacted_revision: 1, node_revision: 1 })
    expect(await finish_namespace_change(connection, before)).toEqual({ attachments: true, story: true, stories: true })
    const redacted = await begin_namespace_change(connection, 1)
    Object.assign(state.nodes[0]!, { redacted_avif_key: null, redacted_jpeg_key: null, redacted_revision: 2, node_revision: 2 })
    expect(await finish_namespace_change(connection, redacted)).toEqual({ attachments: true, story: true, stories: true })
    expect(state.writes.some(sql => sql.startsWith('UPDATE content_stories SET markdown'))).toBe(false)
  })

  it('atomically journals the final rename, rewrites cover/body and leaves body revision unchanged', async () => {
    await with_namespace_change(1, async () => {
      state.nodes[0]!.file_name = 'new.png'
    })
    expect(state.story).toMatchObject({ markdown: expect.stringContaining('[](att://new.png)'), cover: 'new.png', revision: 7, namespace_revision: 1 })
    expect(state.journals).toEqual([{ scope_id: 1, revision: 1, changes: [{ node_id: 11, from: 'att://old.png', to: 'att://new.png', is_folder: false }] }])
    expect(state.committed).toBe(1)
    expect(state.locks[0]).toContain('FROM content_stories')
  })

  it('records an upload/byte replacement with an empty mapping and skips no-op revisions', async () => {
    await with_namespace_change(1, async () => {})
    expect(state.journals).toEqual([])
    await with_namespace_change(1, async () => {
      state.nodes[0]!.version = 'v2'
    })
    expect(state.story).toMatchObject({ revision: 7, namespace_revision: 1, cover_version: 'v2' })
    expect(state.journals[0]?.changes).toEqual([])
  })

  it('rewrites a draft without writing, refreshing or consuming its body revision', async () => {
    const old = state.story.markdown
    await with_namespace_change(1, async () => {
      state.nodes[0]!.file_name = 'new.png'
    })
    state.writes = []
    const result = await rewrite_draft_references(1, old, { base_namespace_revision: 0, base_title_revision: 0 }, true)
    expect(result.markdown).toBe(state.story.markdown)
    expect(result.base_namespace_revision).toBe(1)
    expect(state.writes).toEqual([])
    expect(state.events).toEqual([])
    expect(state.story.revision).toBe(7)
    expect(state.locks.at(- 3)).toContain('content_title_namespace')
  })

  it.each([null, 0])('keeps unavailable baseline %s unknown instead of guessing the current name', async (baseline) => {
    state.story.namespace_revision = 5
    state.story.namespace_floor = 3
    state.nodes[0]!.file_name = 'new.png'
    const result = await rewrite_draft_references(1, state.story.markdown, { base_namespace_revision: baseline, base_title_revision: 0 }, true)
    expect(result.base_namespace_revision).toBe(baseline)
    expect(result.baseline_unavailable.namespace).toBe(true)
    expect(result.markdown).toContain('att://old.png')
    expect(result.diagnostics).toMatchObject([{ target: 'old.png', reason: 'missing' }, { target: 'old.png', reason: 'missing' }])
    expect(state.writes).toEqual([])
  })

  it('refuses to save when the reference history is unavailable', async () => {
    state.story.namespace_revision = 5
    state.story.namespace_floor = 3
    const baseline = { base_namespace_revision: 0, base_title_revision: 0 }
    const failure = await update_story(1, state.story.markdown, 7, true, baseline).catch(error => error)
    expect(failure).toMatchObject({ statusCode: 409, reference_code: 'REF_HISTORY_UNAVAILABLE', review_token: expect.any(String) })
    expect(state.writes).toEqual([])
    expect(state.rolled_back).toBe(1)
    await expect(update_story(1, `${state.story.markdown}\nchanged`, 7, true, baseline, failure.review_token))
      .rejects.toMatchObject({ statusCode: 409, reference_code: 'REF_HISTORY_UNAVAILABLE' })
    state.title_revision ++
    await expect(update_story(1, state.story.markdown, 7, true, baseline, failure.review_token))
      .rejects.toMatchObject({ statusCode: 409, reference_code: 'REF_HISTORY_UNAVAILABLE' })
    state.title_revision --
    await expect(update_story(1, state.story.markdown, 7, true, baseline, failure.review_token))
      .resolves.toMatchObject({ revision: 8, baseline_unavailable: { namespace: true, title: false } })
  })

  it('keeps revision and private-content checks when history is confirmed', async () => {
    const baseline = { base_namespace_revision: null, base_title_revision: null }
    await expect(update_story(1, state.story.markdown, 6, true, baseline, 'a'.repeat(64))).rejects.toMatchObject({ statusCode: 409 })
    state.story.markdown += '\n<good>secret</good>'
    await expect(update_story(1, state.story.markdown, 7, false, baseline, 'a'.repeat(64))).rejects.toMatchObject({ statusCode: 403 })
    expect(state.writes).toEqual([])
  })

  it('replays at save even when the client missed every namespace event', async () => {
    const old = state.story.markdown
    await with_namespace_change(1, async () => {
      state.nodes[0]!.file_name = 'new.png'
    })
    const result = await update_story(1, old, 7, true, { base_namespace_revision: 0, base_title_revision: 0 })
    expect(result.markdown).toContain('att://new.png')
    expect(result).toMatchObject({ revision: 8, namespace_revision: 1 })
    expect(state.story.markdown).not.toContain('att://old.png')
  })

  it('saves ordinary Markdown targets unchanged without migration diagnostics or reference rewriting', async () => {
    const submitted = `${state.story.markdown}\n[文件](old.png) [档案](@其他档案)\n[label][f]\n\n[f]: docs/file.pdf`
    const result = await update_story(1, submitted, 7, true, { base_namespace_revision: 0, base_title_revision: 0 })
    expect(result.markdown).toBe(submitted)
    expect(result.diagnostics).toEqual([])
    expect(state.story.markdown).toBe(submitted)
    expect(state.story.revision).toBe(8)
    expect(state.committed).toBe(1)
    expect(state.rolled_back).toBe(0)
  })

  it('replays the original submission once when a title change retries with an exclusive lock', async () => {
    state.story.namespace_revision = 1
    state.nodes = [
      { id: 11, file_name: 'new.png', is_folder: 0, object_key: 'key', version: 'v1' },
      { id: 12, file_name: 'last.png', is_folder: 0, object_key: 'key2', version: 'v1' },
    ]
    state.journals = [{ scope_id: 1, revision: 1, changes: [{ node_id: 11, from: 'old.png', to: 'new.png' }, { node_id: 12, from: 'new.png', to: 'last.png' }] }]
    const submitted = `${state.story.markdown.replace('title: 本文', 'title: 改标题')} [](att://new.png)`
    const result = await update_story(1, submitted, 7, true, { base_namespace_revision: 0, base_title_revision: 0 })
    expect(result.markdown).toContain('[](att://new.png) [](att://last.png)')
    expect(result.markdown).toContain('cover: att://new.png')
    expect(state.story.revision).toBe(8)
    const title_locks = state.locks.filter(sql => sql.includes('content_title_namespace'))
    expect(title_locks).toHaveLength(2)
    expect(title_locks[0]).toContain('FOR SHARE')
    expect(title_locks[1]).toContain('FOR UPDATE')
    expect(state.rolled_back).toBe(1)
  })

  it('allows an attachment reference to point to a same-name replacement', async () => {
    state.story.namespace_revision = 2
    state.journals = [{ scope_id: 1, revision: 1, changes: [{ node_id: 11, from: 'old.png', to: null }] }, { scope_id: 1, revision: 2, changes: [] }]
    state.nodes[0]!.id = 99
    const draft = await rewrite_draft_references(1, state.story.markdown, { base_namespace_revision: 0, base_title_revision: 0 }, true)
    expect(draft.base_namespace_revision).toBe(2)
    expect(draft.diagnostics).toEqual([])
    await expect(update_story(1, state.story.markdown, 7, true, { base_namespace_revision: 0, base_title_revision: 0 })).resolves.toMatchObject({ revision: 8, namespace_revision: 2 })
  })

  it('allows saving a dangling attachment reference and later follows the same name', async () => {
    state.story.namespace_revision = 1
    state.journals = [{ scope_id: 1, revision: 1, changes: [{ node_id: 11, from: 'old.png', to: null }] }]
    state.nodes = []
    const baseline = { base_namespace_revision: 0, base_title_revision: 0 }
    const dangling = await rewrite_draft_references(1, state.story.markdown, baseline, true)
    expect(dangling.base_namespace_revision).toBe(1)
    expect(dangling.diagnostics[0]?.reason).toBe('missing')
    await expect(update_story(1, state.story.markdown, 7, true, baseline)).resolves.toMatchObject({ revision: 8 })
    state.story.namespace_revision = 2
    state.nodes = [{ id: 99, file_name: 'old.png', is_folder: 0, object_key: 'new-owner', version: 'v2' }]
    state.journals.push({ scope_id: 1, revision: 2, changes: [] })
    const recreated = await rewrite_draft_references(1, dangling.markdown, dangling, true)
    expect(recreated.diagnostics).toEqual([])
    expect(recreated.base_namespace_revision).toBe(2)
  })

  it('silently accepts a same-name replacement of a referenced story', async () => {
    state.title_revision = 1
    state.journals = [{ scope_id: 0, revision: 1, changes: [{ node_id: 10, from: '新标题', to: null }] }]
    const markdown = `${state.story.markdown}\n[](content://新标题)`
    const draft = await rewrite_draft_references(1, markdown, { base_namespace_revision: 0, base_title_revision: 0 }, true)
    expect(draft.markdown).toBe(markdown)
    expect(draft.base_title_revision).toBe(1)
    expect(draft.diagnostics).toEqual([])
    await expect(update_story(1, markdown, 7, true, { base_namespace_revision: 0, base_title_revision: 0 }))
      .resolves.toMatchObject({ markdown, revision: 8 })
  })

  it('checks the locked document for body conflicts and private access', async () => {
    await expect(update_story(1, state.story.markdown, 6, true)).rejects.toMatchObject({ statusCode: 409 })
    state.story.markdown += '\n<good>secret</good>'
    await expect(update_story(1, '---\ntitle: 本文\ntime: 2026/10/14\n---\n公开', 7, false)).rejects.toMatchObject({ statusCode: 403 })
    expect(state.writes).toEqual([])
    expect(state.events).toEqual([])
  })
})
