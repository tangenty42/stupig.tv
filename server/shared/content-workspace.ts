import { z } from 'zod'
import { attachment_base_name, attachment_folder_of, attachment_has_private_suffix, attachment_inherits_private, attachment_name_without_private_suffix, attachment_path_is_private, attachment_path_violation, attachment_redaction_path, link_file_name_byte_length, link_file_name_illegal_chars, sanitize_attachment_path, split_attachment_editable_name } from './content-markdown'
import { settings } from './settings'

export const error_categories = ['name_conflict', 'reserved', 'source_busy', 'invalid_name', 'other', 'redacted'] as const
export type ErrorCategory = typeof error_categories[number]
export type ErrorAction = 'fail' | 'skip' | 'suffix' | 'sanitize' | 'keep' | 'discard'
export const error_actions: Record<ErrorCategory, ErrorAction[]> = {
  name_conflict: ['fail', 'skip', 'suffix'], reserved: ['fail', 'skip', 'suffix'],
  source_busy: ['fail', 'skip'], invalid_name: ['fail', 'skip', 'sanitize'], other: ['fail', 'skip'], redacted: ['fail', 'skip', 'keep', 'discard'],
}
const error_choices_schema = z.strictObject({
  name_conflict: z.enum(['fail', 'skip', 'suffix']).default('fail'),
  reserved: z.enum(['fail', 'skip', 'suffix']).default('fail'),
  source_busy: z.enum(['fail', 'skip']).default('fail'),
  invalid_name: z.enum(['fail', 'skip', 'sanitize']).default('fail'),
  other: z.enum(['fail', 'skip']).default('fail'),
  redacted: z.enum(['fail', 'skip', 'keep', 'discard']).default('fail'),
})
export const error_policy_schema = error_choices_schema.extend({
  by_item: z.record(z.string().regex(/^-?\d+$/), error_choices_schema).optional(),
})
export type ErrorPolicy = z.infer<typeof error_policy_schema>
export function choices_for_item(policy: ErrorPolicy, item: number) {
  return policy.by_item?.[item] ?? policy
}
/** `group` is the selected folder of a folder upload; the whole folder succeeds or fails together. */
export interface WorkspaceIssue { target: string, category: ErrorCategory, code: string, reason: string, allowed: ErrorAction[], group?: string, item?: number, is_folder?: boolean }
export interface WorkspaceReport {
  succeeded: string[]
  skipped: { target: string, code: string, reason: string }[]
  renamed: { target: string, from: string, to: string, via: 'suffix' | 'sanitize' }[]
}
export const workspace_issue_schema = z.strictObject({
  target: z.string(), category: z.enum(error_categories), code: z.string(), reason: z.string(),
  allowed: z.array(z.enum(['fail', 'skip', 'suffix', 'sanitize', 'keep', 'discard'])),
  group: z.string().optional(), item: z.number().int().optional(), is_folder: z.boolean().optional(),
})

/** Apply only the choices the user saw, keeping earlier rounds of this command. */
export function apply_resolution_choices(previous: ErrorPolicy, issues: WorkspaceIssue[], choices: ErrorPolicy): ErrorPolicy {
  const next = { ... previous }
  const by_item = { ... previous.by_item }
  for (const { category, item } of issues) {
    if (item === undefined) {
      // Older servers report category-wide issues without identifying an item.
      Object.assign(next, { [category]: choices[category] })
      continue
    }
    by_item[item] = { ... (by_item[item] ?? error_choices_schema.parse({})), [category]: choices[category] }
    next.by_item = by_item
  }
  return next
}
export const workspace_target_schema = z.strictObject({ id: z.number().int().positive(), version: z.string().min(1) })
/** Digest of the approved attachment state changes. See SID#2.4.4.LAW. */
export const privacy_digest_schema = z.string().regex(/^[\da-f]{64}$/)
const base = { request_id: z.uuid(), scope_id: z.number().int().positive(), on_error: error_policy_schema.default(() => error_policy_schema.parse({})), privacy_digest: privacy_digest_schema.optional() }
export const workspace_command_schema = z.discriminatedUnion('operation', [
  z.strictObject({ ... base, operation: z.literal('create_folder'), parent_id: z.number().int().positive(), name: z.string() }),
  z.strictObject({ ... base, operation: z.literal('rename'), target: workspace_target_schema, name: z.string() }),
  z.strictObject({ ... base, operation: z.literal('move'), targets: z.array(workspace_target_schema).min(1).max(settings.app.content.workspace.batchLimit), parent_id: z.number().int().positive() }),
  z.strictObject({ ... base, operation: z.literal('delete'), targets: z.array(workspace_target_schema).min(1).max(settings.app.content.workspace.batchLimit) }),
  z.strictObject({ ... base, operation: z.literal('delete_redacted'), target: workspace_target_schema }),
  z.strictObject({ ... base, operation: z.literal('set_private'), targets: z.array(workspace_target_schema).min(1).max(settings.app.content.workspace.batchLimit), private: z.boolean() }),
])
export type WorkspaceCommand = z.infer<typeof workspace_command_schema>

/** One comparison rule for the browser planner, service and binary DB unique key. */
export const attachment_name_key = (name: string) => name.normalize('NFC').toLowerCase()

const privacy_state_schema = z.strictObject({ private: z.boolean(), redaction: z.boolean() })
export const privacy_change_schema = z.strictObject({ path: z.string(), is_folder: z.boolean(), from: privacy_state_schema, to: privacy_state_schema })
export type PrivacyChange = z.infer<typeof privacy_change_schema>
/** `PRIVACY_CONFIRMATION` details; the digest covers the complete change list. */
export interface PrivacyConfirmation { changes: PrivacyChange[], total: number, digest: string }
/** A stored row (`stored_private` set) or an upload reservation, keyed by a stable identity. */
export interface PrivacyItem { id: string, path: string, is_folder: boolean, stored_private?: boolean }

function privacy_states(items: readonly PrivacyItem[]) {
  const redactions = new Set(items.flatMap((item) => {
    const twin = item.is_folder ? null : attachment_redaction_path(item.path)
    return twin ? [attachment_name_key(twin)] : []
  }))
  return new Map(items.map((item) => {
    const redaction = ! item.is_folder && redactions.has(attachment_name_key(item.path))
    // Mirrors apply_attachment_privacy: a legacy private row outside `.good` paths stays private.
    const value = attachment_path_is_private(item.path) ? ! redaction : item.stored_private ?? false
    return [item.id, { private: value, redaction }]
  }))
}

/** Items whose 机密 or 删减版 state differs; a new item starts as a plain item of its folder. */
export function attachment_privacy_effects(before: readonly PrivacyItem[], after: readonly PrivacyItem[], confirmed_redactions?: ReadonlySet<string>, explicit_private_targets?: ReadonlyMap<string, boolean>): PrivacyChange[] {
  const old = privacy_states(before)
  const next = privacy_states(after)
  return after.flatMap((item) => {
    const previous = old.get(item.id)
    const to = next.get(item.id)!
    if (! previous && to.redaction && ! to.private && confirmed_redactions?.has(item.id))
      return []
    const from = previous ?? { private: attachment_inherits_private(item.path), redaction: false }
    // Only the selected item's intended privacy transition was explicit. Its
    // redaction relationship and every other item's effects still need review.
    if (previous && from.redaction === to.redaction && explicit_private_targets?.get(item.id) === to.private)
      return []
    return from.private === to.private && from.redaction === to.redaction ? [] : [{ path: item.path, is_folder: item.is_folder, from, to }]
  }).sort((a, b) => a.path < b.path ? - 1 : a.path > b.path ? 1 : 0)
}
export function workspace_issue(target: string, category: ErrorCategory, code: string, reason: string): WorkspaceIssue {
  return { target, category, code, reason, allowed: error_actions[category] }
}

/** Plans a name without mutations. Occupancy includes earlier entries in this batch. */
export function resolve_workspace_name(raw: string, folder: boolean, policy: ErrorPolicy, occupied: (path: string) => 'name_conflict' | 'reserved' | null) {
  let path = raw.normalize('NFC')
  const renamed: WorkspaceReport['renamed'] = []
  const fail = (category: ErrorCategory, code: string, reason: string) => ({ path, renamed, issue: workspace_issue(raw, category, code, reason) })
  const invalid = attachment_path_violation(path)
  if (invalid) {
    if (policy.invalid_name !== 'sanitize')
      return fail('invalid_name', 'INVALID_NAME', invalid)
    if (path.replaceAll('\\', '/').split('/').some(segment => ! segment.replace(link_file_name_illegal_chars, '_').trim().replace(/^\.+|\.+$/g, '')))
      return fail('invalid_name', 'INVALID_NAME', '清洗后名称为空，请重新命名')
    path = sanitize_attachment_path(path, settings.app.content.link.fileNameMaxBytes).normalize('NFC')
    if (! path || attachment_path_violation(path))
      return fail('invalid_name', 'INVALID_NAME', '清洗后名称仍不可用')
    renamed.push({ target: raw, from: raw, to: path, via: 'sanitize' })
  }
  const category = occupied(path)
  if (category) {
    if (policy[category] !== 'suffix')
      return fail(category, category === 'reserved' ? 'UPLOAD_RESERVED' : 'NAME_TAKEN', category === 'reserved' ? '目标名称已被上传预约' : '目标名称已被占用')
    const parent = attachment_folder_of(path)
    const name = attachment_base_name(path)
    const parts = folder ? { editable: attachment_name_without_private_suffix(name), locked: attachment_has_private_suffix(name) ? '.good' : '' } : split_attachment_editable_name(name)
    const separator = settings.app.content.name.suffixSeparator
    // Escape the configured separator before embedding it: `.` or `+` would
    // otherwise change the regex meaning and misread existing numbers.
    const match = new RegExp(`${separator.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([1-9]\\d*)$`).exec(parts.editable)
    let stem = match ? parts.editable.slice(0, match.index) : parts.editable
    let index = match ? Number(match[1]) + 1 : 1
    const from = path
    let attempts = 0
    while (Number.isSafeInteger(index) && attempts ++ < settings.app.content.workspace.suffixAttempts) {
      const ending = `${separator}${index}${parts.locked}`
      const prefix = parent ? `${parent}/` : ''
      while (stem && link_file_name_byte_length(`${prefix}${stem}${ending}`) > settings.app.content.link.fileNameMaxBytes)
        stem = Array.from(stem).slice(0, - 1).join('')
      if (! stem)
        return fail('other', 'INVALID_NAME', '名称长度不足以添加后缀')
      path = `${prefix}${stem}${ending}`
      if (! occupied(path)) {
        renamed.push({ target: raw, from, to: path, via: 'suffix' })
        return { path, renamed, issue: null }
      }
      index ++
    }
    return fail('other', 'INVALID_NAME', '名称后缀超出范围')
  }
  return { path, renamed, issue: null }
}
