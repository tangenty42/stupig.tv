/** Saved dialect identifiers are protocol constants, independent of deployment settings. */
export const attachment_ref_scheme = 'att://'
export const story_ref_scheme = 'content://'

export type ContentRef
  = | { kind: 'attachment', path: string }
    | { kind: 'story', title: string }
    | { kind: 'legacy_attachment', path: string }
    | { kind: 'legacy_story', title: string }

// eslint-disable-next-line no-control-regex -- names exclude control characters
export const link_file_name_illegal_chars = /[<>:"?*|()[\]\\/\s#@&=%`\x00-\x1F\x7F]/g

export function decode_content_destination(destination: string) {
  try {
    return decodeURIComponent(destination)
  }
  catch {
    return destination
  }
}

function valid_segment(segment: string) {
  link_file_name_illegal_chars.lastIndex = 0
  return Boolean(segment) && ! link_file_name_illegal_chars.test(segment)
}

/** Parse the original string: URL() would incorrectly treat the first path segment as a host. */
export function parse_content_ref(destination: string): ContentRef | null {
  const decoded = decode_content_destination(destination)
  if (decoded.startsWith(attachment_ref_scheme)) {
    const path = decoded.slice(attachment_ref_scheme.length).replace(/\/$/, '')
    return path.split('/').every(valid_segment) ? { kind: 'attachment', path } : null
  }
  if (decoded.startsWith(story_ref_scheme)) {
    const title = decoded.slice(story_ref_scheme.length)
    return valid_segment(title) ? { kind: 'story', title } : null
  }
  return null
}

/** Offline migration and rejection diagnostics only; never resolves runtime links. */
export function parse_migration_ref(destination: string): ContentRef | null {
  const current = parse_content_ref(destination)
  if (current)
    return current
  const decoded = decode_content_destination(destination)
  if (decoded.startsWith('@')) {
    const title = decoded.slice(1)
    return valid_segment(title) ? { kind: 'legacy_story', title } : null
  }
  if (! decoded || decoded.startsWith('#') || /^[a-z][\w+.-]*:/i.test(decoded))
    return null
  // Match the old parser's permissive syntax, so migration does not discard old references.
  return decoded.split('/').every(Boolean) ? { kind: 'legacy_attachment', path: decoded } : null
}

export function format_attachment_ref(path: string) {
  return attachment_ref_scheme + path.replace(/\/$/, '')
}

export function format_story_ref(title: string) {
  return story_ref_scheme + title
}

/** The same comparison is used by lint, rendering, extraction and title cascades. */
export function content_title_key(title: string) {
  return title.normalize('NFC').toLowerCase()
}
