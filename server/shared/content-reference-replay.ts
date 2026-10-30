import type { ContentReferenceDiagnostic, ContentReferenceJournal } from './types/content-reference'
import { content_ref_changes, map_content_refs } from './content-markdown'
import { content_name_key, content_ref_suffix, content_reference_key, parse_content_ref } from './content-reference'

interface ReferenceTarget { id: number, name: string }
interface Mapping { to: string, segments: number, is_folder: boolean }
interface ReplayBatch { exact: Map<string, Mapping>, folders: Map<string, Mapping> }

function compile_journals(journals: readonly ContentReferenceJournal[]): ReplayBatch[] {
  return journals.map((journal) => {
    const exact = new Map<string, Mapping>()
    const folders = new Map<string, Mapping>()
    for (const change of journal.changes) {
      if (change.from === null || change.to === null)
        continue
      const key = content_reference_key(change.from)
      const ref = parse_content_ref(change.from)
      if (! key || ! ref)
        continue
      const index = change.is_folder ? folders : exact
      if (! index.has(key))
        index.set(key, { to: change.to, segments: 'path' in ref ? ref.path.split('/').length : 0, is_folder: Boolean(change.is_folder) })
    }
    return { exact, folders }
  })
}

/** One match per batch: an exchange never cascades through another simultaneous move. */
export function replay_reference_destination(destination: string, journals: readonly ContentReferenceJournal[]) {
  return replay_compiled(destination, compile_journals(journals))
}

function replay_compiled(destination: string, journals: readonly ReplayBatch[]) {
  let current = destination
  for (const journal of journals) {
    const key = content_reference_key(current)
    if (! key)
      break
    let mapping = journal.exact.get(key) ?? journal.folders.get(key)
    let prefix = key
    while (! mapping) {
      const slash = prefix.lastIndexOf('/')
      if (slash <= prefix.indexOf('://') + 2)
        break
      prefix = prefix.slice(0, slash)
      mapping = journal.folders.get(prefix)
    }
    if (! mapping)
      continue
    const ref = parse_content_ref(current)!
    // Segment counts survive NFC/case folding even when the string length changes.
    const tail = mapping.is_folder && 'path' in ref
      ? ref.path.split('/').slice(mapping.segments).join('/')
      : ''
    current = mapping.to + (tail ? `/${tail}` : '') + content_ref_suffix(current)
  }
  return current
}

/** Main and drafts use the same ordered batches and current-name diagnostics. */
export function replay_content_references(markdown: string, namespaces: {
  attachments: ContentReferenceJournal[]
  titles: ContentReferenceJournal[]
  attachment_targets: ReferenceTarget[]
  title_targets: ReferenceTarget[]
}, include_details = true) {
  const diagnostics: ContentReferenceDiagnostic[] = []
  const attachments = compile_journals(namespaces.attachments)
  const titles = compile_journals(namespaces.titles)
  const attachment_targets = new Set(namespaces.attachment_targets.map(target => content_name_key(target.name)))
  const title_targets = new Set(namespaces.title_targets.map(target => content_name_key(target.name)))
  const rewritten = map_content_refs(markdown, (destination, from, to) => {
    const ref = parse_content_ref(destination)
    if (! ref)
      return destination
    const attachment = 'path' in ref
    const next = replay_compiled(destination, attachment ? attachments : titles)
    const target_ref = parse_content_ref(next)!
    const name = 'path' in target_ref ? target_ref.path : target_ref.title
    const targets = attachment ? attachment_targets : title_targets
    if (include_details && ! targets.has(content_name_key(name))) {
      diagnostics.push({
        kind: attachment ? 'attachment' : 'story', target: name, from, to,
        line: markdown.slice(0, from).split('\n').length,
        reason: 'missing',
      })
    }
    return next
  })
  // Persisted representations need only text. Avoid reparsing both full bodies
  // for editor patches while the caller holds every affected draft row lock.
  return { markdown: rewritten, changes: include_details ? content_ref_changes(markdown, rewritten) : [], diagnostics }
}
