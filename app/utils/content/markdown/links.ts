import type { ContentStorySummary } from '@shared/types/content'
import type { StoryMarkdownOptions } from './types'
import { content_name_key, content_ref_suffix, content_title_key, decode_content_destination, parse_content_ref, parse_migration_ref } from '@shared/content-reference'
import { attachment_display_url } from '~/utils/content/attachment'

/** Attachment file name (or folder path) for a story-relative URL, else null. */
export function local_file_name(url: string) {
  const ref = parse_content_ref(url)
  return ref?.kind === 'attachment' || ref?.kind === 'legacy_attachment' ? ref.path : null
}

/**
 * Markdown-it percent-encodes destinations; decode names for catalog lookup.
 */
export function decode_story_title(encoded: string) {
  return decode_content_destination(encoded)
}

/** Keep link options without replacing the server-issued representation parameters. */
export function with_reference_suffix(target: string, reference: string) {
  const suffix = content_ref_suffix(reference)
  if (! suffix)
    return target
  const url = new URL(target, 'https://reference.invalid')
  const hash = suffix.indexOf('#')
  const search = hash < 0 ? suffix : suffix.slice(0, hash)
  for (const [name, value] of new URLSearchParams(search)) {
    if (! url.searchParams.has(name))
      url.searchParams.append(name, value)
  }
  if (hash >= 0)
    url.hash = suffix.slice(hash)
  return target.startsWith('/') ? url.pathname + url.search + url.hash : url.href
}

/**
 * Resolve att:// destinations through the current attachment projection.
 * Other URLs pass through; legacy business syntax never synthesizes storage URLs.
 */
export function resolve_content_url(options: StoryMarkdownOptions, url: string) {
  if (parse_migration_ref(url)?.kind.startsWith('legacy_'))
    return ''
  const file_name = local_file_name(url)
  if (file_name) {
    // markdown-it percent-encodes the src (e.g. CJK file names), so decode it
    // before matching the attachment's stored (decoded) file name.
    const attachment = file_name ? options.attachments().find(item => content_name_key(item.file_name) === content_name_key(file_name)) : undefined
    if (attachment)
      return with_reference_suffix(attachment_display_url(options.static_url, attachment), url)
    // Missing references never synthesize an old storage URL.
    return ''
  }
  return url
}

// Folded-title indexes, keyed by the stories array's identity so a render
// with many content:// links builds the lookup once per payload, not per link.
const title_index_cache = new WeakMap<ContentStorySummary[], Map<string, ContentStorySummary>>()

/** Case-insensitive title lookup for content:// references. */
export function find_story_by_title(options: StoryMarkdownOptions, title: string) {
  const stories = options.stories()
  let index = title_index_cache.get(stories)
  if (! index) {
    index = new Map(stories.map(story => [content_title_key(story.title), story]))
    title_index_cache.set(stories, index)
  }
  return index.get(content_title_key(title))
}
