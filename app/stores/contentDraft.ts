import { defineStore } from 'pinia'

export interface ContentDraftRecord {
  schema_version: number
  story_id: number | null
  markdown: string
  base_updated_at: string | null
  saved_at: string
}

function is_draft_record(value: unknown, story_id: number | null, schema_version: number): value is ContentDraftRecord {
  if (! value || typeof value !== 'object') {
    return false
  }

  const draft = value as Partial<ContentDraftRecord>
  return draft.schema_version === schema_version
    && draft.story_id === story_id
    && typeof draft.markdown === 'string'
    && (typeof draft.base_updated_at === 'string' || draft.base_updated_at === null)
    && typeof draft.saved_at === 'string'
}

export const useContentDraftStore = defineStore('content-draft', () => {
  const config = useRuntimeConfig().public
  const draft_schema_version = config.content_draft_schema_version
  const draft_storage_prefix = config.content_draft_storage_prefix
  const autosave_delay_ms = config.content_draft_autosave_delay_ms

  const story_id = ref<number | null>(null)
  const markdown = ref('')
  const database_markdown = ref('')
  const base_updated_at = ref<string | null>(null)
  const draft_saved_at = ref<string | null>(null)
  const initialized = ref(false)
  const autosave_pending = ref(false)
  const storage_error = ref(false)

  let autosave_timer: ReturnType<typeof setTimeout> | null = null

  const dirty = computed(() => initialized.value && markdown.value !== database_markdown.value)

  function draft_storage_key(target_story_id: number | null) {
    return `${draft_storage_prefix}${target_story_id ?? 'new'}`
  }

  function clear_timer() {
    if (autosave_timer !== null) {
      clearTimeout(autosave_timer)
      autosave_timer = null
    }
    autosave_pending.value = false
  }

  function remove_persisted(target_story_id = story_id.value) {
    if (import.meta.client) {
      try {
        localStorage.removeItem(draft_storage_key(target_story_id))
        storage_error.value = false
      }
      catch {
        storage_error.value = true
      }
    }
    draft_saved_at.value = null
  }

  function read_persisted(target_story_id: number | null) {
    if (! import.meta.client) {
      return null
    }

    try {
      const key = draft_storage_key(target_story_id)
      const raw = localStorage.getItem(key)
      if (! raw) {
        return null
      }

      const parsed = JSON.parse(raw) as unknown
      if (is_draft_record(parsed, target_story_id, draft_schema_version)) {
        return parsed
      }

      localStorage.removeItem(key)
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
      story_id: story_id.value,
      markdown: markdown.value,
      base_updated_at: base_updated_at.value,
      saved_at,
    }

    try {
      localStorage.setItem(draft_storage_key(story_id.value), JSON.stringify(draft))
      draft_saved_at.value = saved_at
      storage_error.value = false
    }
    catch {
      storage_error.value = true
    }
  }

  function schedule_persist() {
    clear_timer()
    if (! initialized.value || ! import.meta.client) {
      return
    }

    if (! dirty.value) {
      remove_persisted()
      return
    }

    autosave_pending.value = true
    autosave_timer = setTimeout(persist_now, autosave_delay_ms)
  }

  function initialize(target_story_id: number | null, current_markdown: string, current_updated_at: string | null) {
    clear_timer()
    story_id.value = target_story_id
    markdown.value = current_markdown
    database_markdown.value = current_markdown
    base_updated_at.value = current_updated_at
    draft_saved_at.value = null
    storage_error.value = false
    initialized.value = true
  }

  function restore(draft: ContentDraftRecord, current_markdown: string, current_updated_at = draft.base_updated_at) {
    clear_timer()
    story_id.value = draft.story_id
    markdown.value = draft.markdown
    database_markdown.value = current_markdown
    base_updated_at.value = current_updated_at
    draft_saved_at.value = draft.saved_at
    storage_error.value = false
    initialized.value = true
  }

  function advance_base(current_markdown: string, current_updated_at: string) {
    database_markdown.value = current_markdown
    base_updated_at.value = current_updated_at
    schedule_persist()
  }

  function mark_saved(current_markdown: string, current_updated_at: string) {
    clear_timer()
    markdown.value = current_markdown
    database_markdown.value = current_markdown
    base_updated_at.value = current_updated_at
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
    base_updated_at,
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
})
