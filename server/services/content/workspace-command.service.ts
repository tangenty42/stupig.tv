import type { WorkspaceCommand, WorkspaceIssue, WorkspaceReport } from '@shared/content-workspace'
import type { WorkspaceRow } from './workspace.repository'
import { ApiError } from '@server/errors/ApiError'
import { attachment_base_name, attachment_inherits_private, attachment_path_is_private, decrypted_attachment_name, is_encrypted_attachment, link_file_name_byte_length, split_attachment_editable_name } from '@shared/content-markdown'
import { attachment_name_key, resolve_workspace_name, workspace_issue } from '@shared/content-workspace'
import { settings } from '@shared/settings'
import { attachment_owned_object_keys } from './attachment-objects'
import { enqueue_object_retirement } from './object-retirement.repository'
import { redacted_object_keys } from './redacted-variant'
import { begin_namespace_change, finish_namespace_change } from './reference-history.service'
import { require_workspace_actor } from './workspace-auth.service'
import { active_reservations, ensure_workspace_root, node_version, subtree, workspace_rows, workspace_transaction } from './workspace.repository'

export async function execute_workspace_command(actor: number, command: WorkspaceCommand) {
  const result = await workspace_transaction(actor, command.request_id, command.scope_id, command, async (connection) => {
    const before = await begin_namespace_change(connection, command.scope_id)
    await ensure_workspace_root(connection, command.scope_id)
    const rows = await workspace_rows(connection, command.scope_id)
    const { rows: reservations, expired_sessions: upload_sessions } = await active_reservations(connection, command.scope_id)
    const by_id = new Map(rows.map(row => [Number(row.id), row]))
    const parent = 'parent_id' in command ? by_id.get(command.parent_id) : undefined
    if ('parent_id' in command && (! parent?.is_folder))
      throw new ApiError(400, '目标目录不存在')
    const requested = 'targets' in command ? command.targets : 'target' in command ? [command.target] : []
    // Ignore descendants already covered by a selected root, even for forged clients.
    const roots = requested.filter((target, index) => requested.findIndex(other => other.id === target.id) === index)
      .filter(target => ! requested.some(other => other.id !== target.id && by_id.get(other.id)?.is_folder && by_id.get(target.id)?.file_name.startsWith(`${by_id.get(other.id)!.file_name}/`)))
    const issues: WorkspaceIssue[] = []
    const report: WorkspaceReport = { succeeded: [], skipped: [], renamed: [] }
    const plans: { node: WorkspaceRow, path: string | null, parent: number, private?: boolean }[] = []
    const record = (issue: WorkspaceIssue) => {
      if (command.on_error[issue.category] === 'skip')
        report.skipped.push({ target: issue.target, code: issue.code, reason: issue.reason })
      else
        issues.push(issue)
    }
    const plan_name = (raw: string, folder: boolean, owner: WorkspaceRow | null, destination: WorkspaceRow, private_marker = false) => {
      const full = (value: string) => `${destination.file_name ? `${destination.file_name}/` : ''}${value}${private_marker ? '.good' : ''}`
      if (raw.includes('/') || raw.includes('\\')) {
        const issue = workspace_issue(raw, 'invalid_name', 'INVALID_NAME', '名称不能包含目录分隔符，请重新命名')
        issue.allowed = ['fail', 'skip']
        return { path: full(raw), renamed: [], issue }
      }
      const extension_locked = (value: string) => owner && ! folder && command.operation === 'rename'
        && split_attachment_editable_name(value).locked !== split_attachment_editable_name(decrypted_attachment_name(owner.name)).locked
      const locked_issue = () => {
        const issue = workspace_issue(raw, 'invalid_name', 'EXTENSION_LOCKED', '重命名不能修改文件后缀')
        issue.allowed = ['fail', 'skip']
        return issue
      }
      if (extension_locked(raw))
        return { path: full(raw), renamed: [], issue: locked_issue() }
      const resolved = resolve_workspace_name(raw, folder, command.on_error, (value) => {
        const key = attachment_name_key(value + (private_marker ? '.good' : ''))
        if (rows.some(row => row.id !== owner?.id && Number(row.parent_id) === Number(destination.id) && row.name_key === key) || plans.some(plan => plan.path && Number(plan.parent) === Number(destination.id) && attachment_name_key(attachment_base_name(plan.path)) === key))
          return 'name_conflict'
        if (reservations.some(item => Number(item.target_parent_id) === Number(destination.id) && item.target_name_key === key))
          return 'reserved'
        return null
      })
      if (! resolved.issue && extension_locked(resolved.path))
        return { path: full(resolved.path), renamed: [], issue: locked_issue() }
      const path = full(resolved.path)
      if (link_file_name_byte_length(path) > settings.app.content.link.fileNameMaxBytes)
        resolved.issue = workspace_issue(raw, 'other', 'INVALID_NAME', '完整路径过长')
      return { ... resolved, path }
    }
    if (command.operation === 'create_folder') {
      const resolved = plan_name(command.name, true, null, parent!)
      if (resolved.issue) {
        record(resolved.issue)
      }
      else {
        await require_workspace_actor(actor, attachment_path_is_private(resolved.path), connection)
        const name = attachment_base_name(resolved.path)
        await connection.execute(`INSERT INTO content_story_attachments (story_id, parent_id, name, name_key, file_name, is_folder, is_private, version, storage_provider)
          VALUES (?, ?, ?, ?, ?, 1, ?, '', 'aliyun')`, [command.scope_id, parent!.id, name, attachment_name_key(name), resolved.path, attachment_path_is_private(resolved.path) ? 1 : 0])
        report.succeeded.push(resolved.path)
        report.renamed.push(... resolved.renamed)
      }
    }
    for (const target of roots) {
      const node = by_id.get(target.id)
      const label = node?.file_name ?? String(target.id)
      let issue: WorkspaceIssue | null = null
      if (! node || node.parent_id === 0)
        issue = workspace_issue(label, 'other', 'NOT_FOUND', '目标不存在或不能操作根目录')
      else if (node_version(rows, node) !== target.version)
        issue = workspace_issue(label, 'other', 'SOURCE_CHANGED', '目标或子树已变化，请重新确认')
      if (issue || ! node) {
        record(issue!)
        continue
      }
      const descendants = subtree(rows, node)
      await require_workspace_actor(actor, descendants.some(row => Boolean(row.is_private) || attachment_path_is_private(row.file_name)) || (command.operation === 'set_private'), connection)
      const ids = new Set(descendants.map(row => Number(row.id)))
      const protected_source = (id: unknown) => command.operation === 'delete' ? ids.has(Number(id)) : Number(id) === Number(node.id)
      if (reservations.some(item => protected_source(item.source_attachment_id) || protected_source(item.replacement_attachment_id) || (command.operation === 'delete' && ids.has(Number(item.target_parent_id)))))
        issue = workspace_issue(label, 'source_busy', 'SOURCE_BUSY', '目标仍有未完成上传或替换')
      if (command.operation === 'move' && ids.has(Number(parent!.id)))
        issue = workspace_issue(label, 'other', 'MOVE_INTO_SELF', '不能移动到自身或子目录')
      if (issue) {
        record(issue)
        continue
      }
      if (command.operation === 'delete_redacted') {
        if (node.is_folder)
          throw new ApiError(400, '仅支持图片附件')
        await require_workspace_actor(actor, true, connection)
        await connection.execute('UPDATE content_story_attachments SET redacted_avif_key = NULL, redacted_jpeg_key = NULL, redacted_metadata = NULL, redacted_lqip_jpeg = NULL, redacted_revision = redacted_revision + 1, read_revision = read_revision + 1, node_revision = node_revision + 1 WHERE id = ?', [node.id])
        for (const key of redacted_object_keys(node)) await enqueue_object_retirement(connection, key, command.scope_id, 'redacted-delete')
        report.succeeded.push(node.file_name)
        continue
      }
      if (command.operation === 'delete') {
        plans.push({ node, path: null, parent: Number(node.parent_id) })
        continue
      }
      const destination = command.operation === 'move' ? parent! : by_id.get(Number(node.parent_id))!
      if (command.operation === 'set_private' && ! command.private && attachment_inherits_private(node.file_name)) {
        record(workspace_issue(label, 'other', 'INHERITED_PRIVATE', '机密状态由父目录继承，不能单独取消'))
        continue
      }
      // Inherited access is not a declaration on the file itself. Moving it out
      // of a private directory must not manufacture a permanent leaf marker.
      const private_marker = command.operation === 'set_private' ? command.private : ! node.is_folder && (is_encrypted_attachment(node.name) || (Boolean(node.is_private) && ! attachment_inherits_private(node.file_name)))
      const raw = command.operation === 'rename' ? command.name : command.operation === 'set_private' || ! node.is_folder ? decrypted_attachment_name(node.name) : node.name
      const resolved = plan_name(raw, Boolean(node.is_folder), node, destination, private_marker)
      if (resolved.issue) {
        record(resolved.issue)
      }
      else if (descendants.some(row => link_file_name_byte_length(resolved.path + row.file_name.slice(node.file_name.length)) > settings.app.content.link.fileNameMaxBytes)) {
        record(workspace_issue(label, 'other', 'INVALID_NAME', '子路径过长'))
      }
      else {
        const effective_private = attachment_path_is_private(resolved.path)
        await require_workspace_actor(actor, effective_private, connection)
        // A reserved upload's processing/access policy cannot follow an ACL
        // change silently. Ordinary same-policy directory renames still work.
        const changes_access = descendants.some(row => attachment_path_is_private(resolved.path + row.file_name.slice(node.file_name.length)) !== (row.is_folder ? attachment_path_is_private(row.file_name) : Boolean(row.is_private)))
        if (changes_access && reservations.some(item => ids.has(Number(item.target_parent_id)) || ids.has(Number(item.source_attachment_id)) || ids.has(Number(item.replacement_attachment_id)))) {
          record(workspace_issue(label, 'source_busy', 'SOURCE_BUSY', '目录仍有未完成传输，暂不能改变机密状态'))
          continue
        }
        plans.push({ node, path: resolved.path, parent: Number(destination.id), private: effective_private })
        report.renamed.push(... resolved.renamed)
      }
    }
    if (issues.length)
      throw new ApiError(409, '整批未执行，请处理以下项目', { code: 'BATCH_REJECTED', details: { items: issues, valid_count: plans.length + report.succeeded.length, valid_targets: [... plans.map(plan => plan.node.file_name), ... report.succeeded] } })
    for (const plan of plans) {
      if (plan.path === null) {
        for (const row of subtree(rows, plan.node)) {
          for (const key of attachment_owned_object_keys(row))
            await enqueue_object_retirement(connection, key, command.scope_id, 'delete')
          await connection.execute('DELETE FROM content_story_attachments WHERE id = ?', [row.id])
        }
      }
      // Successful no-ops still have a receipt, but must not manufacture a new
      // node version or namespace change. Validation and expiry cleanup still run.
      else if (plan.path !== plan.node.file_name || plan.parent !== Number(plan.node.parent_id) || plan.private !== Boolean(plan.node.is_private)) {
        const name = attachment_base_name(plan.path)
        if (plan.private !== Boolean(plan.node.is_private))
          await connection.execute('UPDATE content_story_attachments SET read_revision = read_revision + 1 WHERE id = ?', [plan.node.id])
        await connection.execute('UPDATE content_story_attachments SET parent_id = ?, name = ?, name_key = ?, is_private = ?, node_revision = node_revision + 1 WHERE id = ?',
          [plan.parent, name, attachment_name_key(name), plan.private ? 1 : 0, plan.node.id])
        for (const child of subtree(rows, plan.node)) {
          const path = plan.path + child.file_name.slice(plan.node.file_name.length)
          const child_private = attachment_path_is_private(path)
          if (child.id !== plan.node.id && child_private !== Boolean(child.is_private)) {
            await connection.execute('UPDATE content_story_attachments SET is_private = ?, read_revision = read_revision + 1, node_revision = node_revision + 1 WHERE id = ?', [child_private ? 1 : 0, child.id])
          }
          await connection.execute('UPDATE content_story_attachments SET file_name = ? WHERE id = ?', [path, child.id])
        }
      }
      report.succeeded.push(plan.path ?? plan.node.file_name)
    }
    // Session targets follow their parent identity. The final name itself stays reserved.
    const current = await workspace_rows(connection, command.scope_id)
    for (const reservation of reservations) {
      const intent = typeof reservation.intent === 'string' ? JSON.parse(reservation.intent) : reservation.intent
      const directory = current.find(row => Number(row.id) === Number(reservation.target_parent_id))
      if (directory && intent.target_name) {
        const path = directory.file_name ? `${directory.file_name}/${intent.target_name}` : intent.target_name
        if (path !== reservation.target_path) {
          await connection.execute('UPDATE content_transfer_sessions SET target_path = ?, revision = revision + 1 WHERE id = ?', [path, reservation.id])
          upload_sessions.push(String(reservation.id))
        }
      }
    }
    const refresh = await finish_namespace_change(connection, before)
    if (upload_sessions.length)
      refresh.upload_sessions = upload_sessions
    return { ... report, refresh }
  })
  const { refresh: _refresh, ... report } = result
  return report
}
