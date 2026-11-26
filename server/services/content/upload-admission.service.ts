import type { UploadBatch } from '@shared/content-upload'
import type { WorkspaceIssue, WorkspaceReport } from '@shared/content-workspace'
import type { PrivacyReservation } from './privacy-confirmation'
import { randomUUID } from 'node:crypto'
import { ApiError } from '@server/errors/ApiError'
import { image_upload_error } from '@shared/content-image-upload'
import { attachment_base_name, attachment_folder_of, attachment_mime_type, attachment_name_without_private_suffix, attachment_path_is_private, attachment_redaction_path, link_file_name_byte_length, normalized_attachment_extension, processable_image_mime, redactable_attachment_mime, split_attachment_editable_name } from '@shared/content-markdown'
import { upload_content_mime } from '@shared/content-upload'
import { attachment_name_key, choices_for_item, resolve_workspace_name, workspace_issue } from '@shared/content-workspace'
import { settings } from '@shared/settings'
import { privacy_items, require_privacy_confirmation } from './privacy-confirmation'
import { has_redacted_variant } from './redacted-variant'
import { begin_namespace_change, finish_namespace_change } from './reference-history.service'
import { accept_transfer } from './transfer-session.repository'
import { require_workspace_actor } from './workspace-auth.service'
import { active_reservations, ensure_workspace_folders, ensure_workspace_root, node_version, workspace_rows, workspace_transaction } from './workspace.repository'

/** One admission transaction for the whole selection; never starts storage IO. */
export async function admit_upload_batch(actor: number, input: UploadBatch) {
  return workspace_transaction(actor, input.request_id, input.scope_id, input, async (connection) => {
    const before = await begin_namespace_change(connection, input.scope_id)
    await ensure_workspace_root(connection, input.scope_id)
    const rows = await workspace_rows(connection, input.scope_id)
    const redaction_names = new Set(rows.flatMap((row) => {
      const path = row.is_folder ? null : attachment_redaction_path(row.file_name)
      return path ? [attachment_name_key(path)] : []
    }))
    const { rows: reservations, expired_sessions } = await active_reservations(connection, input.scope_id)
    const issues: WorkspaceIssue[] = []
    const report: WorkspaceReport = { succeeded: [], skipped: [], renamed: [] }
    const plans: { index: number, path: string, access: 'public' | 'private', confirmed_redaction: boolean }[] = []
    const groups = new Map<string, { index: number, entry: UploadBatch['entries'][number] }[]>()
    input.entries.forEach((entry, index) => {
      const key = entry.selection_root ? `folder:${entry.selection_root}` : `file:${index}`
      groups.set(key, [... groups.get(key) ?? [], { index, entry }])
    })
    const record = (issue: WorkspaceIssue, item: number) => {
      if (choices_for_item(input.on_error, item)[issue.category] === 'skip')
        report.skipped.push({ target: issue.target, code: issue.code, reason: issue.reason })
      else
        issues.push(input.on_error.by_item ? { ... issue, item } : issue)
    }
    for (const group of groups.values()) {
      const root = group[0]!.entry.selection_root
      const plan_start = plans.length
      const rename_start = report.renamed.length
      const group_issues: { issue: WorkspaceIssue, index: number }[] = []
      let root_path = root
      if (root) {
        // Files use their entry index; folder decisions must survive a root rename independently.
        const root_item = - (group[0]!.index + 1)
        const resolved = resolve_workspace_name(root, true, choices_for_item(input.on_error, root_item), (path) => {
          const key = attachment_name_key(path)
          // Same-named folders merge; only files block the folder root.
          const intersects = (other: string) => key === other || key.startsWith(`${other}/`)
          if (rows.some(row => row.parent_id !== 0 && ! row.is_folder && intersects(attachment_name_key(row.file_name))) || plans.some(plan => intersects(attachment_name_key(plan.path))))
            return 'name_conflict'
          if (reservations.some(item => intersects(attachment_name_key(String(item.target_path)))))
            return 'reserved'
          return null
        })
        if (resolved.issue) {
          record({ ... resolved.issue, target: resolved.path, is_folder: true }, root_item)
          continue
        }
        root_path = resolved.path
        report.renamed.push(... resolved.renamed)
      }
      for (const { index, entry } of group) {
        let issue: WorkspaceIssue | null = null
        const choices = choices_for_item(input.on_error, index)
        const source = entry.source && rows.find(row => Number(row.id) === entry.source!.id && ! row.is_folder)
        const replacement = entry.purpose === 'replace' || entry.image_mode === 'redacted' ? source : entry.replacement && rows.find(row => Number(row.id) === entry.replacement!.id && ! row.is_folder)
        const requested_path = normalized_attachment_extension(root ? root_path! + entry.path.slice(root.length) : entry.path)
        const overwrite_source = entry.image_mode === 'overwrite' ? source : undefined
        // Overwrite edits the source's display objects, never its namespace or
        // access. Older editors sent the name without the final `.good`.
        const target = overwrite_source?.file_name ?? requested_path
        if ((entry.source && (! source || node_version(rows, source) !== entry.source.version)) || (entry.purpose !== 'create' && ! source) || (entry.replacement && (! replacement || node_version(rows, replacement) !== entry.replacement.version)))
          issue = workspace_issue(target, 'other', 'SOURCE_CHANGED', '原附件已变化，请刷新后重试')
        if (entry.purpose === 'redact' && entry.image_mode !== 'redacted')
          issue = workspace_issue(target, 'other', 'INVALID_REDACTION', '请从图片菜单编辑当前附件的删减版本')
        if (entry.purpose === 'redact' && source && (! source.is_private || (! entry.image_mode && (! processable_image_mime(source.mime_type ?? attachment_mime_type(attachment_name_without_private_suffix(source.file_name))) || ! redactable_attachment_mime(source.file_name) || attachment_name_key(entry.path) !== attachment_name_key(attachment_name_without_private_suffix(source.file_name))))))
          issue = workspace_issue(target, 'other', 'INVALID_REDACTION', '删减版必须对应机密原图及相同格式')
        if (entry.image_mode && (! source?.display_key || ! source.image_revision || (entry.image_mode === 'overwrite' && ! [source.file_name, attachment_name_without_private_suffix(source.file_name)].some(path => attachment_name_key(requested_path) === attachment_name_key(path)))))
          issue = workspace_issue(target, 'other', 'INVALID_IMAGE_EDIT', '图片尚未处理就绪或覆盖目标名称已变化')
        const source_redaction = entry.image_mode === 'copy' && source ? attachment_redaction_path(source.file_name) : null
        const source_redaction_key = source_redaction ? attachment_name_key(source_redaction) : null
        const names_source_redaction = source_redaction_key !== null && source_redaction_key === attachment_name_key(target)
        if (entry.image_mode === 'copy' && split_attachment_editable_name(target).locked !== '.webp' && ! names_source_redaction)
          issue = workspace_issue(target, 'other', 'INVALID_IMAGE_COPY_NAME', '图片副本的后缀固定为 .webp')
        if (entry.save_as_redaction && (! source?.is_private || ! names_source_redaction))
          issue = workspace_issue(target, 'other', 'INVALID_REDACTION', '删减版必须对应机密原图的同名路径')
        if (replacement && entry.image_mode !== 'redacted' && has_redacted_variant(replacement) && ! ['keep', 'discard'].includes(choices.redacted))
          issue = workspace_issue(target, 'redacted', 'REDACTED_EXISTS', '已有删减版，请选择保留或删除；关闭可取消此次覆盖')
        const requested_private = source && (entry.purpose === 'replace' || entry.image_mode) ? Boolean(source.is_private) : entry.access === 'private'
        // A replaced row no longer provides its old `<name>.good` twin. Other
        // existing private rows still make their matching target a public 删减版.
        const replaced_redaction = replacement && attachment_redaction_path(replacement.file_name)
        const replaced_redaction_key = replaced_redaction ? attachment_name_key(replaced_redaction) : null
        const access_for = (path: string): 'public' | 'private' => {
          if (overwrite_source)
            return overwrite_source.is_private ? 'private' : 'public'
          const key = attachment_name_key(path)
          if (entry.purpose === 'redact' || (key !== replaced_redaction_key && redaction_names.has(key)))
            return 'public'
          return attachment_path_is_private(path) || requested_private ? 'private' : 'public'
        }
        let access = access_for(target)
        await require_workspace_actor(actor, access === 'private' || Boolean(source?.is_private) || Boolean(replacement?.is_private), connection)
        if (entry.size <= 0 || entry.size > settings.app.content.upload.maxSizeMb * 1024 ** 2)
          issue = workspace_issue(target, 'other', 'INVALID_SIZE', '文件为空或超过上传大小上限')
        if (entry.image_mode || processable_image_mime(upload_content_mime(entry))) {
          const message = image_upload_error(entry.size)
          if (message)
            issue = workspace_issue(target, 'other', 'INVALID_IMAGE_SIZE', message)
        }
        const protected_ids = [source?.id, replacement?.id].filter(Boolean).map(Number)
        if (reservations.some(item => protected_ids.includes(Number(item.source_attachment_id)) || protected_ids.includes(Number(item.replacement_attachment_id))) || plans.some((plan) => {
          const planned = input.entries[plan.index]!
          return [planned.source?.id, planned.replacement?.id].some(id => id && protected_ids.includes(id))
        })) {
          issue = workspace_issue(target, 'other', 'SOURCE_BUSY', '原附件已有未完成传输')
        }
        const stored_path = (path: string) => overwrite_source?.file_name ?? (entry.image_mode === 'redacted' && source ? source.file_name : access_for(path) === 'private' && ! attachment_path_is_private(path) ? `${path}.good` : path)
        // Folder members resolve like ordinary items: a colliding member is
        // renumbered on its own, leaving the folder structure and its
        // siblings' relative names intact.
        const resolved = resolve_workspace_name(target, false, overwrite_source ? { ... choices, name_conflict: 'fail', reserved: 'fail', invalid_name: 'fail' } : choices, (path) => {
          const key = attachment_name_key(stored_path(path))
          const occupied = rows.filter(row => row.id !== replacement?.id && row.parent_id !== 0)
          if (occupied.some(row => attachment_name_key(row.file_name) === key || (! row.is_folder && key.startsWith(`${attachment_name_key(row.file_name)}/`))) || plans.some(plan => attachment_name_key(plan.path) === key || key.startsWith(`${attachment_name_key(plan.path)}/`) || attachment_name_key(plan.path).startsWith(`${key}/`)))
            return 'name_conflict'
          if (reservations.some(item => attachment_name_key(String(item.target_path)) === key || key.startsWith(`${attachment_name_key(String(item.target_path))}/`)))
            return 'reserved'
          return null
        })
        if (overwrite_source && resolved.issue)
          resolved.issue.allowed = ['fail', 'skip']
        // Explicit sanitization can expose a marker, e.g. `secret.good.`, and
        // renumbering can leave the 删减版 name. Recheck the resolved path.
        access = access_for(resolved.path)
        if (access === 'private')
          await require_workspace_actor(actor, true, connection)
        issue = resolved.issue ?? issue
        if (! issue && link_file_name_byte_length(stored_path(resolved.path)) > settings.app.content.link.fileNameMaxBytes)
          issue = workspace_issue(target, 'other', 'INVALID_NAME', '完整路径过长')
        if (issue) {
          group_issues.push({ index, issue: { ... issue, target: stored_path(resolved.path), is_folder: false, ... (root_path ? { group: root_path } : {}) } })
          continue
        }
        const path = stored_path(resolved.path)
        // Conflict resolution may rename the copy away from the agreed public target.
        const confirmed_redaction = entry.save_as_redaction === true && access === 'public' && source_redaction_key === attachment_name_key(path)
        plans.push({ index, path, access, confirmed_redaction })
        report.renamed.push(... resolved.renamed)
      }
      if (group_issues.length) {
        plans.splice(plan_start)
        report.renamed.splice(rename_start)
        if (! root) {
          record(group_issues[0]!.issue, group[0]!.index)
        }
        else {
          const unresolved = group_issues.filter(({ index, issue }) => choices_for_item(input.on_error, index)[issue.category] !== 'skip')
          if (! unresolved.length) {
            const { code, reason } = group_issues[0]!.issue
            report.skipped.push({ target: root_path!, code, reason })
            continue
          }
          for (const { index, issue } of unresolved)
            issues.push(input.on_error.by_item ? { ... issue, item: index } : issue)
        }
      }
    }
    if (issues.length)
      throw new ApiError(409, '整批未受理，请处理以下项目', { code: 'BATCH_REJECTED', details: { items: issues.slice(0, settings.app.content.workspace.batchLimit), valid_count: plans.length } })
    const accepted: { index: number, session_id: string, path: string }[] = []
    const admitted: PrivacyReservation[] = []
    const confirmed_redactions = new Set<string>()
    for (const plan of plans) {
      const entry = input.entries[plan.index]!
      const redacted = choices_for_item(input.on_error, plan.index).redacted
      const redacted_policy = redacted === 'keep' || redacted === 'discard' ? redacted : undefined
      const parent = await ensure_workspace_folders(connection, input.scope_id, attachment_folder_of(plan.path) ?? '')
      const source = entry.source && rows.find(row => Number(row.id) === entry.source!.id)
      const mime = upload_content_mime(entry)
      const image = entry.image_mode || processable_image_mime(mime)
        ? {
            mode: entry.image_mode ?? 'upload' as const,
            source: entry.image_mode && source ? { id: Number(source.id), revision: Number(source.image_revision), node_revision: Number(source.node_revision), key: source.display_key!, is_private: Boolean(source.is_private) } : null,
            original_name: attachment_base_name(entry.original_name ?? entry.path), original_mime: entry.image_mode ? 'image/png' : mime ?? 'application/octet-stream',
            input_basis: entry.image_mode ? entry.image_input_basis ?? 'display' : undefined,
            redacted_policy,
            // A public copy of a private image is only admitted as its 删减版.
            ... (entry.image_mode === 'copy' && source?.is_private && plan.access === 'public' ? { redaction: true as const } : {}),
          }
        : undefined
      const row = await accept_transfer(connection, actor, randomUUID(), {
        operation: 'upload', scope_id: input.scope_id, target_location: 'aliyun', target_path: plan.path,
        target_parent_id: parent, target_name: attachment_base_name(plan.path), target_access: plan.access,
        expected_size: entry.size, mime_type: mime ?? undefined, purpose: entry.purpose, redacted_policy, source: entry.source, replacement: entry.replacement, image,
      }, settings.app.content.workspace.sessionHours * 3600)
      await connection.execute('UPDATE content_transfer_sessions SET target_parent_id = ?, target_name_key = ?, source_attachment_id = ?, replacement_attachment_id = ? WHERE id = ?',
        [parent, attachment_name_key(attachment_base_name(plan.path)), entry.source?.id ?? null, entry.replacement?.id ?? null, row.id])
      accepted.push({ index: plan.index, session_id: row.id, path: plan.path })
      admitted.push({ id: row.id, target_path: plan.path, source_attachment_id: entry.source?.id, replacement_attachment_id: entry.replacement?.id, intent: { purpose: entry.purpose, image } })
      if (plan.confirmed_redaction)
        confirmed_redactions.add(`session:${row.id}`)
      report.succeeded.push(plan.path)
    }
    if (accepted.length) {
      require_privacy_confirmation(
        privacy_items(rows, reservations),
        privacy_items(await workspace_rows(connection, input.scope_id), [... reservations, ... admitted]),
        input.privacy_digest,
        confirmed_redactions,
      )
    }
    const refresh = await finish_namespace_change(connection, before)
    if (accepted.length)
      refresh.uploads = true
    if (expired_sessions.length)
      refresh.upload_sessions = expired_sessions
    return { ... report, accepted, refresh }
  })
}
