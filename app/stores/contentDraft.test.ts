import { story_markdown_template } from '@shared/content-markdown'
import { settings } from '@shared/settings'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computed, nextTick, ref, watch } from 'vue'

/**
 * Regression tests for the "a draft of an existing story's edit leaks into the
 * new-story draft" bug.
 *
 * The draft used to live in one global Pinia store whose storage key was derived
 * from a mutable `story_id`, while Vue mounts the INCOMING page before it
 * unmounts the OUTGOING one (vue@3.5 runtime-core `patchSuspense` -> `resolve`:
 * the new branch is patched into `suspense.hiddenContainer`, the old branch is
 * unmounted, then the new page's mount effects are flushed):
 *
 *   1. incoming page setup()           -> draft_store.initialize(...)
 *   2. outgoing page onBeforeUnmount() -> draft_store.persist_now()
 *   3. incoming page onMounted()       -> read_persisted() + restore()
 *
 * Any async continuation still in flight on the OUTGOING page (the
 * `content_story` sync subscriber -> mark_saved, do_save completing, attachment
 * ops rewriting markdown) therefore ran after step 1 and wrote the old story's
 * markdown through the incoming page's key.
 *
 * The store is now instantiated per edit target, so each of those steps can only
 * touch the instance that owns it. Every test below drives two page instances
 * through that real ordering.
 */

const DRAFT_PREFIX = settings.app.content.draft.storagePrefix
const SCHEMA_VERSION = settings.app.content.draft.schemaVersion
const AUTOSAVE_DELAY_MS = settings.app.content.draft.autosaveDelayMs
const STORY_ID = 24
const STORY_KEY = `${DRAFT_PREFIX}${STORY_ID}`
const NEW_KEY = `${DRAFT_PREFIX}new`

const STORY_24_MARKDOWN = [
  '---',
  'title: 币战·三国',
  `label: ${'#人上人'} 桌游`,
  'time: 2026/8/23',
  '---',
  '',
  '《币战·三国》大体上以《币战·经典》的『各自为战』模式为基础~',
  '',
].join('\n')
const NEW_TEMPLATE = story_markdown_template('2026/9/14')

const mocks = vi.hoisted(() => {
  const storage = new Map<string, string>()
  return {
    storage,
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => void storage.set(key, value),
      removeItem: (key: string) => void storage.delete(key),
    },
  }
})

vi.stubGlobal('localStorage', mocks.localStorage)
// The store relies on Nuxt auto-imports; in a plain Node test they are globals.
vi.stubGlobal('ref', ref)
vi.stubGlobal('computed', computed)
vi.stubGlobal('watch', watch)

const { useContentDraftStore } = await import('~/stores/contentDraft')

interface StoredDraft {
  schema_version: number
  story_id: number | null
  markdown: string
  base_revision: number | null
  saved_at: string
}

function stored(key: string) {
  const raw = mocks.storage.get(key)
  return raw ? JSON.parse(raw) as StoredDraft : null
}

function seed_draft(key: string, draft: Partial<StoredDraft>) {
  mocks.storage.set(key, JSON.stringify({
    schema_version: SCHEMA_VERSION,
    story_id: null,
    markdown: '',
    base_revision: null,
    saved_at: '2026-09-14T08:31:14.548Z',
    ... draft,
  }))
}

/** One page instance for one edit target, exactly as `setup()` creates it. */
function open_page(target: number | null) {
  return useContentDraftStore(target)
}

describe('content draft store: per-page draft ownership', () => {
  /** Let the `markdown` watcher flush (microtask) and the autosave timer fire. */
  async function flush_autosave() {
    await nextTick()
    vi.advanceTimersByTime(AUTOSAVE_DELAY_MS + 1)
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    mocks.storage.clear()
    setActivePinia(createPinia())
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('control: a create page that only edits itself persists and restores its own draft', async () => {
    const page = open_page(null)
    page.initialize(NEW_TEMPLATE, null)
    page.markdown = `${NEW_TEMPLATE}新建档案的正文\n`
    await flush_autosave()

    expect(stored(NEW_KEY)).toMatchObject({ story_id: null, markdown: `${NEW_TEMPLATE}新建档案的正文\n` })
    expect(stored(STORY_KEY)).toBeNull()

    setActivePinia(createPinia())
    const reopened = open_page(null)
    expect(reopened.read_persisted()?.markdown).toBe(`${NEW_TEMPLATE}新建档案的正文\n`)
  })

  it('rejects a record whose story_id does not match the page target', () => {
    seed_draft(NEW_KEY, { story_id: STORY_ID, markdown: STORY_24_MARKDOWN, base_revision: 6 })

    expect(open_page(null).read_persisted()).toBeNull()
    expect(mocks.storage.has(NEW_KEY)).toBe(false)
  })

  it('rejects the leak fingerprint: a create draft carrying a database revision', () => {
    // The contaminated record from DevTools: `story_id: null` (written while the
    // create page was current) together with a real base revision (the previous
    // story's). No create page can produce that pair, so it is dropped on read.
    seed_draft(NEW_KEY, { story_id: null, base_revision: 642, markdown: STORY_24_MARKDOWN })

    expect(open_page(null).read_persisted()).toBeNull()
    expect(mocks.storage.has(NEW_KEY)).toBe(false)
  })

  it('edit -> create: the outgoing page\'s teardown leaves the incoming draft and state alone', async () => {
    seed_draft(NEW_KEY, { markdown: '上次没写完的新档案' })
    const edit_page = open_page(STORY_ID)
    edit_page.initialize(STORY_24_MARKDOWN, 6)
    edit_page.markdown = `${STORY_24_MARKDOWN}\n最后一行没保存`

    // 1. incoming page setup()
    const create_page = open_page(null)
    create_page.initialize(NEW_TEMPLATE, null)
    expect(create_page.markdown).toBe(NEW_TEMPLATE)

    // 2. outgoing page onBeforeUnmount()
    edit_page.persist_now()

    // 3. incoming page onMounted()
    const draft = create_page.read_persisted()
    expect(draft?.markdown).toBe('上次没写完的新档案')
    create_page.restore(draft!, NEW_TEMPLATE)
    await flush_autosave()

    expect(create_page.markdown).toBe('上次没写完的新档案')
    expect(create_page.base_revision).toBeNull()
    expect(stored(NEW_KEY)?.markdown).toBe('上次没写完的新档案')
    // The outgoing page's own last edits survived its teardown.
    expect(stored(STORY_KEY)?.markdown).toContain('最后一行没保存')
  })

  it('edit -> create: a late mark_saved() from the outgoing page stays on the outgoing page', async () => {
    const edit_page = open_page(STORY_ID)
    edit_page.initialize(STORY_24_MARKDOWN, 6)

    const create_page = open_page(null)
    create_page.initialize(NEW_TEMPLATE, null)

    // The outgoing page's `content_story` subscriber (or do_save) completing
    // after the create page took over: `await fetch_story()` then mark_saved().
    edit_page.mark_saved(`${STORY_24_MARKDOWN}\n别人刚保存的版本`, 7)

    expect(create_page.markdown).toBe(NEW_TEMPLATE)
    expect(create_page.base_revision).toBeNull()
    expect(create_page.dirty).toBe(false)

    await flush_autosave()
    expect(stored(NEW_KEY)).toBeNull()
  })

  it('edit -> create: a late markdown rewrite from the outgoing page saves under its own key', async () => {
    const edit_page = open_page(STORY_ID)
    edit_page.initialize(STORY_24_MARKDOWN, 6)

    const create_page = open_page(null)
    create_page.initialize(NEW_TEMPLATE, null)

    // In-flight attachment work on the outgoing page (move/rename rewriting
    // references, an upload inserting its reference, the old editor instance
    // pushing its document back through v-model).
    edit_page.markdown = `${STORY_24_MARKDOWN}\n![](/content/${STORY_ID}/cover.png)`
    await flush_autosave()

    expect(stored(NEW_KEY)).toBeNull()
    expect(stored(STORY_KEY)?.markdown).toContain(`/content/${STORY_ID}/cover.png`)
  })

  it('edit -> create: the incoming page\'s initialize() no longer cancels the outgoing autosave', async () => {
    const edit_page = open_page(STORY_ID)
    edit_page.initialize(STORY_24_MARKDOWN, 6)
    edit_page.markdown = `${STORY_24_MARKDOWN}\n没来得及保存的最后一行`
    await nextTick()
    expect(mocks.storage.has(STORY_KEY)).toBe(false)

    const create_page = open_page(null)
    create_page.initialize(NEW_TEMPLATE, null)
    vi.advanceTimersByTime(AUTOSAVE_DELAY_MS + 1)

    expect(stored(STORY_KEY)?.markdown).toContain('没来得及保存的最后一行')
  })

  it('create -> edit: a discarded create page cannot write anything on teardown', async () => {
    const create_page = open_page(null)
    create_page.initialize(NEW_TEMPLATE, null)
    create_page.markdown = `${NEW_TEMPLATE}刚创建的内容\n`

    // do_create() -> discard() then navigateTo(`/content/${result.id}/edit`)
    create_page.discard()
    const edit_page = open_page(99)
    edit_page.initialize('新故事', 1)

    create_page.persist_now()

    expect(mocks.storage.has(NEW_KEY)).toBe(false)
    expect(mocks.storage.has(`${DRAFT_PREFIX}99`)).toBe(false)
  })

  it('edit -> edit: each story keeps its own draft', async () => {
    const story_24_page = open_page(STORY_ID)
    story_24_page.initialize(STORY_24_MARKDOWN, 6)
    story_24_page.markdown = `${STORY_24_MARKDOWN}\n24 的未保存修改`

    const story_25_page = open_page(25)
    story_25_page.initialize('故事 25 的原文', 3)
    story_25_page.markdown = '25 的未保存修改'

    story_24_page.persist_now()
    story_25_page.persist_now()

    expect(stored(STORY_KEY)?.markdown).toContain('24 的未保存修改')
    expect(stored(`${DRAFT_PREFIX}25`)?.markdown).toBe('25 的未保存修改')
  })

  it('an instance only ever writes its own key', async () => {
    const edit_page = open_page(STORY_ID)
    edit_page.initialize(STORY_24_MARKDOWN, 6)
    edit_page.markdown = `${STORY_24_MARKDOWN}\n编辑`
    const create_page = open_page(null)
    create_page.initialize(NEW_TEMPLATE, null)
    create_page.markdown = `${NEW_TEMPLATE}新建`
    await flush_autosave()

    expect([... mocks.storage.keys()].sort()).toEqual([NEW_KEY, STORY_KEY].sort())
  })
})
