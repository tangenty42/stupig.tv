import type { ContentDeleteReference, ContentDeleteTarget } from './types/content-delete-impact'
import { map_content_refs } from './content-markdown'
import { content_name_key, format_attachment_ref, parse_content_ref } from './content-reference'

/** Uses the same reference scanner and identity as replay, including bare covers. */
export function find_delete_references(markdown: string, targets: ContentDeleteTarget[]): ContentDeleteReference[] {
  const result: ContentDeleteReference[] = []
  map_content_refs(markdown, (destination, from) => {
    const line_start = markdown.lastIndexOf('\n', from - 1) + 1
    const bare_cover = /^cover:\s*$/.test(markdown.slice(line_start, from))
    const ref = parse_content_ref(destination) ?? (bare_cover ? parse_content_ref(format_attachment_ref(destination)) : null)
    if (! ref)
      return destination
    const name = 'path' in ref ? ref.path : ref.title
    const key = content_name_key(name)
    for (const target of targets) {
      if ((target.kind === 'story') !== (ref.kind === 'story'))
        continue
      const target_key = content_name_key(target.path)
      const missing = key === target_key || (target.kind === 'folder' && key.startsWith(`${target_key}/`))
      const contents = target.kind !== 'story' && target_key.startsWith(`${key}/`)
      if (missing || contents) {
        const line = markdown.slice(0, from).split('\n').length
        const entry: ContentDeleteReference = { target: name, line, effect: missing ? 'missing' : 'contents' }
        if (! result.some(item => item.target === entry.target && item.line === entry.line && item.effect === entry.effect))
          result.push(entry)
      }
    }
    return destination
  })
  return result.sort((a, b) => a.line - b.line)
}
