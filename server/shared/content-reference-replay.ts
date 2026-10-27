import type { ContentReferenceDiagnostic, ContentReferenceJournal } from './types/content-reference'
import { content_ref_changes, map_content_refs, rewrite_attachment_path } from './content-markdown'
import { content_title_key, format_attachment_ref, format_story_ref, parse_content_ref } from './content-reference'

interface ReferenceTarget {
  id: number
  name: string
}

/** Replay a snapshot against identities, rather than guessing from current names. */
export function replay_content_references(markdown: string, namespaces: {
  attachments: ContentReferenceJournal[]
  titles: ContentReferenceJournal[]
  attachment_targets: ReferenceTarget[]
  title_targets: ReferenceTarget[]
}) {
  const diagnostics: ContentReferenceDiagnostic[] = []
  let deleted_reference = false
  let deleted_story_reference = false
  const rewritten = map_content_refs(markdown, (destination, from, to) => {
    const ref = parse_content_ref(destination)
    if (! ref)
      return destination
    const attachment = 'path' in ref
    let name = attachment ? ref.path : ref.title
    const key = attachment ? (value: string) => value : content_title_key
    let deleted_id: number | null = null
    for (const journal of attachment ? namespaces.attachments : namespaces.titles) {
      if (deleted_id !== null && ! attachment)
        break
      const deleted = journal.changes.find(change => change.to === null
        && (key(change.from) === key(name) || (attachment && change.is_folder && name.startsWith(`${change.from}/`))))
      if (deleted && deleted_id === null) {
        deleted_id = deleted.node_id
        if (! attachment)
          break
      }
      if (attachment) {
        name = rewrite_attachment_path(name, { attachments: journal.changes.flatMap(change => change.to === null ? [] : [{ from: change.from, to: change.to, is_folder: change.is_folder }]) })
      }
      else {
        name = journal.changes.find(change => key(change.from) === key(name))?.to ?? name
      }
    }
    const target = (attachment ? namespaces.attachment_targets : namespaces.title_targets).find(target => key(target.name) === key(name))
    deleted_reference ||= deleted_id !== null
    deleted_story_reference ||= ! attachment && deleted_id !== null
    if (! target || (deleted_id !== null && target.id !== deleted_id)) {
      diagnostics.push({
        kind: attachment ? 'attachment' : 'story', target: name, from, to,
        line: markdown.slice(0, from).split('\n').length,
        reason: target ? 'replaced' : 'missing',
      })
    }
    if (attachment)
      return ref.kind === 'attachment' ? format_attachment_ref(name) : name
    return ref.kind === 'story' ? format_story_ref(name) : `@${name}`
  })
  return { markdown: rewritten, changes: content_ref_changes(markdown, rewritten), diagnostics, deleted_reference, deleted_story_reference }
}
