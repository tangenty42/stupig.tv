import type { ContentStorySummary } from '@shared/types/content'
import type { StoryMarkdownOptions } from './types'
import { content_title_key, decode_content_destination, parse_content_ref } from '@shared/content-reference'

/** Attachment file name (or folder path) for a story-relative URL, else null. */
export function local_file_name(url: string) {
  const ref = parse_content_ref(url)
  return ref?.kind === 'attachment' || ref?.kind === 'legacy_attachment' ? ref.path : null
}

/**
 * The markdown-it normalized `@title` destination is percent-encoded
 * (e.g. `@%E6%96%B0...`); decode it back for title lookup.
 */
export function decode_story_title(encoded: string) {
  return decode_content_destination(encoded)
}

/**
 * Resolve a link/image destination: bare file names point at the attachment's
 * object URL from the story payload (key-decoupled, with a `?version=` cache
 * bust), while `@title` story references, anchors and absolute/scheme URLs
 * pass through.
 */
export function resolve_content_url(options: StoryMarkdownOptions, url: string) {
  const file_name = local_file_name(url)
  if (file_name) {
    // markdown-it percent-encodes the src (e.g. CJK file names), so decode it
    // before matching the attachment's stored (decoded) file name.
    const attachment = file_name ? options.attachments().find(item => item.file_name === file_name) : undefined
    if (attachment)
      return options.static_url(attachment.url)
    // Unknown attachment: keep the legacy path shape (a dead link either way).
    return options.static_url(`/content/${options.story_id() ?? 0}/${file_name.split('/').map(encodeURIComponent).join('/')}`)
  }
  return url
}

// Folded-title indexes, keyed by the stories array's identity so a render
// with many `@title` links builds the lookup once per payload, not per link.
const title_index_cache = new WeakMap<ContentStorySummary[], Map<string, ContentStorySummary>>()

/** Case-insensitive title lookup for `[](@title)` references. */
export function find_story_by_title(options: StoryMarkdownOptions, title: string) {
  const stories = options.stories()
  let index = title_index_cache.get(stories)
  if (! index) {
    index = new Map(stories.map(story => [content_title_key(story.title), story]))
    title_index_cache.set(stories, index)
  }
  return index.get(content_title_key(title))
}
