export interface EditorScrollPosition {
  top: number
  left: number
}

export interface StoryEditorPosition {
  anchor: number
  head: number
  editor: EditorScrollPosition
  preview: EditorScrollPosition
  page: EditorScrollPosition
}

export interface StoryEditorViewState {
  version: 1
  fullscreen: boolean
  mode: 'edit' | 'preview'
  audience: 'private' | 'public'
  split_ratio: number
  attachments_width: number
  position: StoryEditorPosition | null
}

export function default_editor_view_state(): StoryEditorViewState {
  return { version: 1, fullscreen: false, mode: 'edit', audience: 'private', split_ratio: 0.5, attachments_width: 256, position: null }
}

function finite(value: unknown, fallback = 0) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : fallback
}

function scroll_position(value: unknown): EditorScrollPosition {
  const position = value as Partial<EditorScrollPosition> | null
  return { top: finite(position?.top), left: finite(position?.left) }
}

/** Pick only UI numbers/enums; never round-trip draft text or credentials. */
export function parse_editor_view_state(value: unknown): StoryEditorViewState | null {
  if (! value || typeof value !== 'object' || ! ('version' in value) || value.version !== 1)
    return null
  const input = value as Partial<StoryEditorViewState>
  const position = input.position
  return {
    version: 1,
    fullscreen: input.fullscreen === true,
    mode: input.mode === 'preview' ? 'preview' : 'edit',
    audience: input.audience === 'public' ? 'public' : 'private',
    split_ratio: Math.min(0.8, Math.max(0.2, finite(input.split_ratio, 0.5))),
    attachments_width: Math.min(384, Math.max(160, finite(input.attachments_width, 256))),
    position: position && typeof position === 'object'
      ? { anchor: Math.floor(finite(position.anchor)), head: Math.floor(finite(position.head)), editor: scroll_position(position.editor), preview: scroll_position(position.preview), page: scroll_position(position.page) }
      : null,
  }
}
