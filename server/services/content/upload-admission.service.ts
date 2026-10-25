import type { UploadBatch } from '@shared/content-upload'
import type { WorkspaceIssue, WorkspaceReport } from '@shared/content-workspace'
import { randomUUID } from 'node:crypto'
import { ApiError } from '@server/errors/ApiError'
import { attachment_base_name, attachment_folder_of, attachment_mime_type, attachment_path_is_private, decrypted_attachment_name, link_file_name_byte_length, normalized_attachment_extension, processable_image_mime, redactable_attachment_mime, split_attachment_editable_name } from '@shared/content-markdown'
import { upload_content_mime } from '@shared/content-upload'
import { attachment_name_key, resolve_workspace_name, workspace_issue } from '@shared/content-workspace'
import { settings } from '@shared/settings'
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
    const { rows: reservations, expired_sessions } = await active_reservations(connection, input.scope_id)
    const issues: WorkspaceIssue[] = []
    const report: WorkspaceReport = { succeeded: [], skipped: [], renamed: [] }
    const plans: { index: number, path: string, access: 'public' | 'private' }[] = []
    const groups = new Map<string, { index: number, entry: UploadBatch['entries'][number] }[]>()
    input.entries.forEach((entry, index) => {
      const key = entry.selection_root ? `folder:${entry.selection_root}` : `file:${index}`
      groups.set(key, [... groups.get(key) ?? [], { index, entry }])
    })
    const record = (issue: WorkspaceIssue) => {
      if (input.on_error[issue.category] === 'skip')
        report.skipped.push({ target: issue.target, code: issue.code, reason: issue.reason })
      else
        issues.push(issue)
    }
    for (const group of groups.values()) {
      const root = group[0]!.entry.selection_root
      const plan_start = plans.length
      const rename_start = report.renamed.length
      const group_issues: WorkspaceIssue[] = []
      let root_path = root
      if (root) {
        const resolved = resolve_workspace_name(root, true, input.on_error, (path) => {
          const key = attachment_name_key(path)
          const intersects = (other: string, folder: boolean) => key === other || other.startsWith(`${key}/`) || (! folder && key.startsWith(`${other}/`))
          if (rows.some(row => row.parent_id !== 0 && intersects(attachment_name_key(row.file_name), Boolean(row.is_folder))) || plans.some(plan => intersects(attachment_name_key(plan.path), false)))
            return 'name_conflict'
          if (reservations.some(item => intersects(attachment_name_key(String(item.target_path)), false)))
            return 'reserved'
          return null
        })
        if (resolved.issue) {
          record(resolved.issue)
          continue
        }
        root_path = resolved.path
        report.renamed.push(... resolved.renamed)
      }
      for (const { index, entry } of group) {
        let issue: WorkspaceIssue | null = null
        const source = entry.source && rows.find(row => Number(row.id) === entry.source!.id && ! row.is_folder)
        const replacement = entry.purpose === 'replace' || entry.image_mode === 'redacted' ? source : entry.replacement && rows.find(row => Number(row.id) === entry.replacement!.id && ! row.is_folder)
        const target = normalized_attachment_extension(root ? root_path! + entry.path.slice(root.length) : entry.path)
        if ((entry.source && (! source || node_version(rows, source) !== entry.source.version)) || (entry.purpose !== 'create' && ! source) || (entry.replacement && (! replacement || node_version(rows, replacement) !== entry.replacement.version)))
          issue = workspace_issue(target, 'other', 'SOURCE_CHANGED', '原附件已变化，请刷新后重试')
        if (entry.purpose === 'redact' && entry.image_mode !== 'redacted')
          issue = workspace_issue(target, 'other', 'INVALID_REDACTION', '请从图片菜单编辑当前附件的删减版本')
        if (entry.purpose === 'redact' && source && (! source.is_private || (! entry.image_mode && (! processable_image_mime(source.mime_type ?? attachment_mime_type(decrypted_attachment_name(source.file_name))) || ! redactable_attachment_mime(source.file_name) || attachment_name_key(entry.path) !== attachment_name_key(decrypted_attachment_name(source.file_name))))))
          issue = workspace_issue(target, 'other', 'INVALID_REDACTION', '删减版必须对应机密原图及相同格式')
        if (entry.image_mode && (! source?.avif_key || ! source.image_revision || (entry.image_mode === 'overwrite' && attachment_name_key(target) !== attachment_name_key(decrypted_attachment_name(source.file_name)))))
          issue = workspace_issue(target, 'other', 'INVALID_IMAGE_EDIT', '图片尚未处理就绪或覆盖目标名称已变化')
        if (entry.image_mode === 'copy' && split_attachment_editable_name(target).locked !== '.avif')
          issue = workspace_issue(target, 'other', 'INVALID_IMAGE_COPY_NAME', '图片副本的后缀固定为 .avif')
        if (replacement && entry.image_mode !== 'redacted' && has_redacted_variant(replacement) && ! ['keep', 'discard'].includes(input.on_error.redacted))
          issue = workspace_issue(target, 'redacted', 'REDACTED_EXISTS', '已有删减版，请选择保留或删除；关闭可取消此次覆盖')
        const requested_private = source && (entry.purpose === 'replace' || entry.image_mode) ? Boolean(source.is_private) : entry.access === 'private'
        let access: 'public' | 'private' = entry.purpose === 'redact' ? 'public' : attachment_path_is_private(target) || requested_private ? 'private' : 'public'
        await require_workspace_actor(actor, access === 'private' || Boolean(source?.is_private) || Boolean(replacement?.is_private), connection)
        if (entry.size <= 0 || entry.size > settings.app.content.upload.maxSizeMb * 1024 ** 2)
          issue = workspace_issue(target, 'other', 'INVALID_SIZE', '文件为空或超过上传大小上限')
        const protected_ids = [source?.id, replacement?.id].filter(Boolean).map(Number)
        if (reservations.some(item => protected_ids.includes(Number(item.source_attachment_id)) || protected_ids.includes(Number(item.replacement_attachment_id))) || plans.some((plan) => {
          const planned = input.entries[plan.index]!
          return [planned.source?.id, planned.replacement?.id].some(id => id && protected_ids.includes(id))
        })) {
          issue = workspace_issue(target, 'other', 'SOURCE_BUSY', '原附件已有未完成传输')
        }
        const stored_path = (path: string) => entry.image_mode === 'redacted' && source ? source.file_name : access === 'private' && ! attachment_path_is_private(path) ? `${path}.good` : path
        const policy = root ? { ... input.on_error, name_conflict: 'fail' as const, reserved: 'fail' as const } : input.on_error
        const resolved = resolve_workspace_name(target, false, policy, (path) => {
          const key = attachment_name_key(stored_path(path))
          const occupied = rows.filter(row => row.id !== replacement?.id && row.parent_id !== 0)
          if (occupied.some(row => attachment_name_key(row.file_name) === key || (! row.is_folder && key.startsWith(`${attachment_name_key(row.file_name)}/`))) || plans.some(plan => attachment_name_key(plan.path) === key || key.startsWith(`${attachment_name_key(plan.path)}/`) || attachment_name_key(plan.path).startsWith(`${key}/`)))
            return 'name_conflict'
          if (reservations.some(item => attachment_name_key(String(item.target_path)) === key || key.startsWith(`${attachment_name_key(String(item.target_path))}/`)))
            return 'reserved'
          return null
        })
        // Explicit sanitization can expose a marker, e.g. `secret.good.`.
        // Recheck the resolved path before accepting its processing policy.
        if (entry.purpose !== 'redact' && attachment_path_is_private(resolved.path)) {
          access = 'private'
          await require_workspace_actor(actor, true, connection)
        }
        issue = resolved.issue ?? issue
        if (! issue && link_file_name_byte_length(stored_path(resolved.path)) > settings.app.content.link.fileNameMaxBytes)
          issue = workspace_issue(target, 'other', 'INVALID_NAME', '完整路径过长')
        if (issue) {
          group_issues.push(root ? { ... issue, target: root, reason: `${entry.path}：${issue.reason}`, allowed: issue.allowed.filter(action => action !== 'suffix') } : issue)
          continue
        }
        plans.push({ index, path: stored_path(resolved.path), access })
        report.renamed.push(... resolved.renamed)
      }
      if (group_issues.length) {
        plans.splice(plan_start)
        report.renamed.splice(rename_start)
        const failure = group_issues.find(issue => input.on_error[issue.category] !== 'skip') ?? group_issues[0]!
        record(failure)
      }
    }
    if (issues.length)
      throw new ApiError(409, '整批未受理，请处理以下项目', { code: 'BATCH_REJECTED', details: { items: issues, valid_count: plans.length, valid_targets: plans.map(plan => plan.path) } })
    const accepted: { index: number, session_id: string, path: string }[] = []
    for (const plan of plans) {
      const entry = input.entries[plan.index]!
      const parent = await ensure_workspace_folders(connection, input.scope_id, attachment_folder_of(plan.path) ?? '')
      const source = entry.source && rows.find(row => Number(row.id) === entry.source!.id)
      const mime = upload_content_mime(entry)
      const image = entry.image_mode || processable_image_mime(mime)
        ? {
            mode: entry.image_mode ?? 'upload' as const,
            source: entry.image_mode && source ? { id: Number(source.id), revision: Number(source.image_revision), node_revision: Number(source.node_revision), key: source.avif_key!, is_private: Boolean(source.is_private) } : null,
            original_name: attachment_base_name(entry.original_name ?? entry.path), original_mime: entry.image_mode ? 'image/png' : mime ?? 'application/octet-stream',
            input_basis: entry.image_mode ? entry.image_input_basis ?? 'avif' : undefined,
            redacted_policy: ['keep', 'discard'].includes(input.on_error.redacted) ? input.on_error.redacted as 'keep' | 'discard' : undefined,
          }
        : undefined
      const row = await accept_transfer(connection, actor, randomUUID(), {
        operation: 'upload', scope_id: input.scope_id, target_location: 'aliyun', target_path: plan.path,
        target_parent_id: parent, target_name: attachment_base_name(plan.path), target_access: plan.access,
        expected_size: entry.size, sha256: entry.sha256, mime_type: mime ?? undefined, purpose: entry.purpose, redacted_policy: ['keep', 'discard'].includes(input.on_error.redacted) ? input.on_error.redacted as 'keep' | 'discard' : undefined, source: entry.source, replacement: entry.replacement, image,
      }, settings.app.content.workspace.sessionHours * 3600)
      await connection.execute('UPDATE content_transfer_sessions SET target_parent_id = ?, target_name_key = ?, source_attachment_id = ?, replacement_attachment_id = ? WHERE id = ?',
        [parent, attachment_name_key(attachment_base_name(plan.path)), entry.source?.id ?? null, entry.replacement?.id ?? null, row.id])
      accepted.push({ index: plan.index, session_id: row.id, path: plan.path })
      report.succeeded.push(plan.path)
    }
    const refresh = await finish_namespace_change(connection, before)
    if (accepted.length)
      refresh.uploads = true
    if (expired_sessions.length)
      refresh.upload_sessions = expired_sessions
    return { ... report, accepted, refresh }
  })
}
