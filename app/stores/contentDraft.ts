import { defineStore } from 'pinia'

export interface ContentDraftRecord {
  schema_version: number
  story_id: number | null
  markdown: string
  base_revision: number | null
  saved_at: string
}

function is_draft_record(value: unknown, story_id: number | null, schema_version: number): value is ContentDraftRecord {
  if (! value || typeof value !== 'object') {
    return false
  }

  const draft = value as Partial<ContentDraftRecord>
  return draft.schema_version === schema_version
    && draft.story_id === story_id
    // A create-page draft never carries a database revision: that pair is the
    // fingerprint of a draft written under the wrong key, so drop it on read.
    && (story_id !== null || draft.base_revision === null)
    && typeof draft.markdown === 'string'
    && (typeof draft.base_revision === 'number' || draft.base_revision === null)
    && typeof draft.saved_at === 'string'
}

/**
 * One store instance per edit target, so a page's draft state and its storage
 * key belong to the page instance that created them: a page being torn down (or
 * a late async continuation from it) can no longer read, overwrite or delete
 * the draft of the page that replaced it.
 */
export function useContentDraftStore(target_story_id: number | null) {
  return defineStore(`content-draft:${target_story_id ?? 'new'}`, () => create_draft_state(target_story_id))()
}

function create_draft_state(target_story_id: number | null) {
  const config = useRuntimeConfig().public
  const draft_schema_version = config.content_draft_schema_version
  const draft_storage_prefix = config.content_draft_storage_prefix
  const autosave_delay_ms = config.content_draft_autosave_delay_ms
  const storage_key = `${draft_storage_prefix}${target_story_id ?? 'new'}`

  const markdown = ref('')
  const database_markdown = ref('')
  const base_revision = ref<number | null>(null)
  const draft_saved_at = ref<string | null>(null)
  const initialized = ref(false)
  const autosave_pending = ref(false)
  const storage_error = ref(false)

  let autosave_timer: ReturnType<typeof setTimeout> | null = null

  const dirty = computed(() => initialized.value && markdown.value !== database_markdown.value)

  function clear_timer() {
    if (autosave_timer !== null) {
      clearTimeout(autosave_timer)
      autosave_timer = null
    }
    autosave_pending.value = false
  }

  function remove_persisted() {
    if (import.meta.client) {
      try {
        localStorage.removeItem(storage_key)
        storage_error.value = false
      }
      catch {
        storage_error.value = true
      }
    }
    draft_saved_at.value = null
  }

  function read_persisted() {
    if (! import.meta.client) {
      return null
    }

    try {
      const raw = localStorage.getItem(storage_key)
      if (! raw) {
        return null
      }

      const parsed = JSON.parse(raw) as unknown
      if (is_draft_record(parsed, target_story_id, draft_schema_version)) {
        return parsed
      }

      localStorage.removeItem(storage_key)
    }
    catch {
      storage_error.value = true
    }
    return null
  }

  function persist_now() {
    clear_timer()
    if (! import.meta.client || ! initialized.value) {
      return
    }

    if (! dirty.value) {
      remove_persisted()
      return
    }

    const saved_at = new Date().toISOString()
    const draft: ContentDraftRecord = {
      schema_version: draft_schema_version,
      story_id: target_story_id,
      markdown: markdown.value,
      base_revision: base_revision.value,
      saved_at,
    }

    try {
      localStorage.setItem(storage_key, JSON.stringify(draft))
      draft_saved_at.value = saved_at
      storage_error.value = false
    }
    catch {
      storage_error.value = true
    }
  }

  function schedule_persist() {
    const had_pending = autosave_pending.value
    clear_timer()
    if (! initialized.value || ! import.meta.client) {
      return
    }

    // This watcher also fires right after initialize(); only purge a stored
    // draft for edits made during this session, or revisiting a page would
    // wipe the draft before onMounted can restore it.
    if (! dirty.value) {
      if (had_pending || draft_saved_at.value) {
        remove_persisted()
      }
      return
    }

    autosave_pending.value = true
    autosave_timer = setTimeout(persist_now, autosave_delay_ms)
  }

  function initialize(current_markdown: string, current_revision: number | null) {
    clear_timer()
    markdown.value = current_markdown
    database_markdown.value = current_markdown
    base_revision.value = current_revision
    draft_saved_at.value = null
    storage_error.value = false
    initialized.value = true
  }

  function restore(draft: ContentDraftRecord, current_markdown: string, current_revision = draft.base_revision) {
    clear_timer()
    markdown.value = draft.markdown
    database_markdown.value = current_markdown
    base_revision.value = current_revision
    draft_saved_at.value = draft.saved_at
    storage_error.value = false
    initialized.value = true
  }

  function advance_base(current_markdown: string, current_revision: number) {
    database_markdown.value = current_markdown
    base_revision.value = current_revision
    schedule_persist()
  }

  function mark_saved(current_markdown: string, current_revision: number) {
    clear_timer()
    markdown.value = current_markdown
    database_markdown.value = current_markdown
    base_revision.value = current_revision
    remove_persisted()
  }

  function discard() {
    clear_timer()
    remove_persisted()
    initialized.value = false
  }

  watch(markdown, schedule_persist)

  return {
    markdown,
    base_revision,
    draft_saved_at,
    initialized,
    autosave_pending,
    storage_error,
    dirty,
    read_persisted,
    initialize,
    restore,
    advance_base,
    mark_saved,
    persist_now,
    discard,
  }
}
