import { createHash } from 'node:crypto'
import { attachment_mime_type, attachment_path_is_private, attachment_path_violation, decrypted_attachment_name, map_content_refs, normalized_attachment_extension, processable_image_mime, upgrade_legacy_refs } from '@shared/content-markdown'
import { content_title_key, format_attachment_ref, parse_migration_ref } from '@shared/content-reference'
import { attachment_name_key } from '@shared/content-workspace'

export interface Node {
  id: number
  story_id: number | null
  file_name: string
  is_folder: number
  is_private: number
  parent_id: number | null
  name_key: string | null
  name: string
  storage_provider: string
  storage_bucket: 'public' | 'private'
  object_key: string | null
  encryption_key: string | null
  version: string
  file_size: number
  mime_type: string | null
  oss_version_id: string | null
  node_revision: number
  original_key: string | null
  avif_key: string | null
  jpeg_key: string | null
  parent_avif_key: string | null
  image_revision: number
  image_metadata: unknown
  lqip_jpeg: Buffer | null
  redacted_avif_key: string | null
  redacted_jpeg_key: string | null
  redacted_metadata: unknown
  redacted_lqip_jpeg: Buffer | null
  redacted_revision: number
  is_edited: number
}
export interface Story {
  id: number
  title: string
  markdown: string
  cover: string
  cover_version: string | null
  revision: number
  namespace_revision: number
  namespace_floor: number
  updated_at: Date | string
}
export interface PlannedNode {
  id: number | null
  old_path: string | null
  path: string
  parent: string | null
  name: string
  key: string
  folder: boolean
  private: boolean
}
export interface ScopePlan {
  nodes: PlannedNode[]
  paths: Record<string, string>
  needs_objects: number[]
  twins: Record<string, number>
  issues: { id?: number, code: string }[]
  changed: boolean
}
export const json = <T>(value: T | string): T => typeof value === 'string' ? JSON.parse(value) : value
export const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')
/** MySQL normalizes JSON member order; canonical identity must survive that round trip. */
export function canonical(value: unknown): string {
  if (value instanceof Date)
    return JSON.stringify(value.toISOString())
  if (Buffer.isBuffer(value))
    return canonical(value.toJSON())
  if (Array.isArray(value))
    return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object')
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
  return JSON.stringify(value)
}
export const snapshot_fingerprint = (story: Story | null, nodes: Node[]) => digest(canonical({ story, nodes }))
export const node_mime = (row: Node) => ! row.mime_type || row.mime_type === 'application/octet-stream' ? attachment_mime_type(decrypted_attachment_name(row.file_name)) ?? row.mime_type : row.mime_type
export const needs_copy = (row: Node) => ! row.is_folder && (row.storage_provider !== 'aliyun' || row.encryption_key !== null || (processable_image_mime(node_mime(row)) && (! row.original_key || ! row.avif_key || ! row.jpeg_key)))

/** Preserve IDs, reject collisions, generate only missing ancestors. No automatic suffixing. */
export function plan_scope(rows: Node[]): ScopePlan {
  const issues: ScopePlan['issues'] = []
  const paths: Record<string, string> = {}
  const by_path = new Map<string, PlannedNode>()
  const private_folders = rows.filter(row => row.is_folder && row.is_private && row.file_name && ! attachment_path_is_private(row.file_name)).map(row => row.file_name)
  const sorted = [... rows].sort((a, b) => a.file_name.split('/').length - b.file_name.split('/').length || Number(b.is_folder) - Number(a.is_folder) || Number(a.id) - Number(b.id))
  for (const row of sorted) {
    if (! Number.isSafeInteger(Number(row.id)) || Number(row.id) <= 0) {
      issues.push({ code: 'invalid_id' })
      continue
    }
    const original_segments = row.file_name.split('/')
    let path = original_segments.map((segment, index) => `${segment.normalize('NFC')}${private_folders.includes(original_segments.slice(0, index + 1).join('/')) ? '.good' : ''}`).join('/')
    if (! row.is_folder)
      path = normalized_attachment_extension(path)
    if ((row.is_private || row.encryption_key) && path && ! attachment_path_is_private(path))
      path += '.good'
    if ((path && attachment_path_violation(path)) || (! path && ! row.is_folder)) {
      issues.push({ id: row.id, code: 'invalid_path' })
      continue
    }
    paths[row.file_name] = path
    if (by_path.has(path)) {
      issues.push({ id: row.id, code: 'duplicate_path' })
      continue
    }
    const segments = path.split('/')
    const name = path ? segments.at(- 1)! : ''
    const parent = path ? segments.slice(0, - 1).join('/') : null
    by_path.set(path, { id: Number(row.id), old_path: row.file_name, path, parent, name, key: attachment_name_key(name), folder: Boolean(row.is_folder), private: attachment_path_is_private(path) })
  }
  if (! by_path.has(''))
    by_path.set('', { id: null, old_path: null, path: '', parent: null, name: '', key: '', folder: true, private: false })
  for (const node of [... by_path.values()]) {
    for (let parent = node.parent; parent !== null; parent = parent ? parent.split('/').slice(0, - 1).join('/') : null) {
      const found = by_path.get(parent)
      if (found && ! found.folder) {
        issues.push({ id: node.id ?? undefined, code: 'file_as_parent' })
        break
      }
      if (! found) {
        const name = parent.split('/').at(- 1)!
        by_path.set(parent, { id: null, old_path: null, path: parent, parent: parent.split('/').slice(0, - 1).join('/'), name, key: attachment_name_key(name), folder: true, private: attachment_path_is_private(parent) })
      }
    }
  }
  const siblings = new Set<string>()
  for (const node of by_path.values()) {
    const key = `${attachment_name_key(node.parent ?? '\0')}/${node.key}`
    if (siblings.has(key))
      issues.push({ id: node.id ?? undefined, code: 'name_collision' })
    siblings.add(key)
  }
  const needs_objects = rows.filter(needs_copy).map(row => Number(row.id))
  const twins: ScopePlan['twins'] = {}
  for (const row of rows.filter(row => ! row.is_folder && /\.good$/i.test(row.file_name) && needs_objects.includes(Number(row.id)))) {
    const twin_path = normalized_attachment_extension(row.file_name.slice(0, - 5)).normalize('NFC')
    const twin = rows.find(candidate => ! candidate.is_folder && ! candidate.is_private && ! candidate.encryption_key
      && ! attachment_path_is_private(paths[candidate.file_name] ?? '') && normalized_attachment_extension(candidate.file_name).normalize('NFC') === twin_path)
    if (twin && processable_image_mime(node_mime(row)) && processable_image_mime(node_mime(twin)))
      twins[String(row.id)] = Number(twin.id)
  }
  const nodes = [... by_path.values()].sort((a, b) => (a.path ? a.path.split('/').length : 0) - (b.path ? b.path.split('/').length : 0) || a.path.localeCompare(b.path))
  return { nodes, paths, needs_objects, twins, issues, changed: needs_objects.length > 0 || nodes.some((node) => {
    const row = rows.find(row => Number(row.id) === node.id)
    const parent = node.parent === null ? 0 : by_path.get(node.parent)?.id
    return ! row || Number(row.parent_id) !== parent || row.parent_id === null || row.name_key !== node.key || row.name !== node.name || row.file_name !== node.path || Boolean(row.is_private) !== node.private
  }) }
}

export function rewrite_markdown(markdown: string, paths: Record<string, string>) {
  return map_content_refs(upgrade_legacy_refs(markdown), (destination) => {
    const ref = parse_migration_ref(destination)
    if (! ref || ! ('path' in ref))
      return destination
    const target = paths[ref.path]
    return target === undefined ? destination : format_attachment_ref(target)
  })
}

export function attachment_references(markdown: string) {
  const paths: string[] = []
  map_content_refs(markdown, (destination) => {
    const ref = parse_migration_ref(destination)
    if (ref && 'path' in ref)
      paths.push(ref.path)
    return destination
  })
  return paths
}

/** Existing unresolved links stay warnings; every previously resolved identity must survive. */
export function require_reference_identity(before: string, after: string, previous: Node[], next: Node[]) {
  const old_refs = attachment_references(before)
  const new_refs = attachment_references(after)
  if (old_refs.length !== new_refs.length)
    throw new Error('migration_reference_shape_changed')
  for (const [index, path] of old_refs.entries()) {
    const original = previous.find(row => row.file_name === path)
    if (original && next.find(row => row.file_name === new_refs[index])?.id !== original.id)
      throw new Error('migration_reference_identity_changed')
  }
}
export function validate_titles(stories: Story[]) {
  const seen = new Set<string>()
  return stories.flatMap((story) => {
    const key = content_title_key(story.title)
    const bad = seen.has(key) || ! parse_migration_ref(`content://${story.title}`)
    seen.add(key)
    return bad ? [{ id: story.id, code: 'ambiguous_or_invalid_title' }] : []
  })
}
