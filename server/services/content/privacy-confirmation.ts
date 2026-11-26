import type { PrivacyItem } from '@shared/content-workspace'
import { createHash } from 'node:crypto'
import { ApiError } from '@server/errors/ApiError'
import { attachment_privacy_effects } from '@shared/content-workspace'

interface PrivacyRow { id: number, parent_id: number | null, file_name: string, is_folder: number, is_private: number }
export interface PrivacyReservation { [column: string]: unknown, id?: unknown, target_path?: unknown, source_attachment_id?: unknown, replacement_attachment_id?: unknown, intent?: unknown }

/** Stored rows plus upload reservations; a replacing reservation moves its row to the target path. */
export function privacy_items(rows: readonly PrivacyRow[], reservations: readonly PrivacyReservation[]): PrivacyItem[] {
  const targets = new Map<number, string>()
  const uploads: PrivacyItem[] = []
  for (const reservation of reservations) {
    const intent = (typeof reservation.intent === 'string' ? JSON.parse(reservation.intent) : reservation.intent) as { purpose?: string, image?: { mode?: string } | null } | null | undefined
    // Same rule as upload publication: these purposes overwrite their source row.
    const replacing = intent?.purpose === 'replace' || intent?.image?.mode === 'redacted' ? reservation.source_attachment_id : reservation.replacement_attachment_id
    if (replacing)
      targets.set(Number(replacing), String(reservation.target_path))
    else
      uploads.push({ id: `session:${String(reservation.id)}`, path: String(reservation.target_path), is_folder: false })
  }
  return [
    ... rows.filter(row => row.parent_id !== 0 && row.file_name).map(row => ({ id: `row:${row.id}`, path: targets.get(Number(row.id)) ?? row.file_name, is_folder: Boolean(row.is_folder), stored_private: Boolean(row.is_private) })),
    ... uploads,
  ]
}

/** Runs after every conflict is resolved and the batch's effects are applied; see SID#2.4.4.LAW. */
export function require_privacy_confirmation(before: readonly PrivacyItem[], after: readonly PrivacyItem[], digest: string | undefined, confirmed_redactions?: ReadonlySet<string>, explicit_private_targets?: ReadonlyMap<string, boolean>) {
  const changes = attachment_privacy_effects(before, after, confirmed_redactions, explicit_private_targets)
  if (! changes.length)
    return
  const expected = createHash('sha256').update(JSON.stringify(changes)).digest('hex')
  if (digest !== expected) {
    throw new ApiError(409, '附件状态将改变，请确认', { code: 'PRIVACY_CONFIRMATION', details: {
      changes, total: changes.length, digest: expected,
    } })
  }
}
