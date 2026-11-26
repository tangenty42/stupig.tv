import type { AdminBackgroundStatus, AdminTaskRunner } from './status'
import { admin_tasks, task_backlog } from './status'
import { storage_audit_kind } from './storage-audit'

export type RunIssue = ({ kind: 'blocked' | 'failed' } | { kind: 'audit', finding_kind: string }) & {
  id: string
  task_error: boolean
  last_failed_at?: string
  title: string
  detail: string
}

const task_names = new Map(admin_tasks.map(task => [task.id, task.name]))
const audit_priority = { error: 0, warning: 1, info: 2, success: 3 }
const finding_titles = new Map([
  ['missing_object', '找不到引用的文件'], ['size_mismatch', '文件大小与记录不符'],
  ['public_object', '文件可以公开读取'], ['invalid_reference', '文件引用无效'],
  ['retired_object_present', '已退役的文件仍在存储桶内'], ['orphan_candidate', '文件归属待确认'],
  ['unregistered_static', '静态文件尚未登记'], ['unmanaged_object', '文件不在本站管理范围内'],
])
const after_failure: Record<AdminTaskRunner['phase'], string> = {
  idle: '当前空闲', queued: '本轮正在排队', running: '本轮正在运行',
}
// A safety hold or scheduled retry can be recorded in last_error_code even when the
// scanner is doing exactly what it should. These remain visible in the task details.
const normal_waits = new Map([
  ['retirement', new Set(['audit_cleanup_disabled', 'audit_object_tracked', 'migration_source_pinned', 'object_referenced', 'preload_in_progress', 'esa_task_not_visible'])],
  ['preload', new Set(['budget_exhausted', 'quota_exhausted', 'queue_full', 'rate_limited', 'lease_lost'])],
])

export function pending_errors(status: AdminBackgroundStatus) {
  const by_task = new Set<string>()
  for (const ledger of status.database.ledgers) {
    if (ledger.groups.some(group => group.pending > 0 && group.error_code && ! normal_waits.get(ledger.id)?.has(group.error_code)))
      by_task.add(ledger.id)
  }
  if (status.database.storage_audit.some(target => target.phase !== 'completed' && target.error_code))
    by_task.add('storage_audit')
  const preload = status.database.ledgers.find(ledger => ledger.id === 'preload')
  if (preload?.groups.some(group => group.pending > 0)
    && status.database.preload_targets.some(site => site.total > 0 && site.error_code && ! normal_waits.get('preload')?.has(site.error_code))) {
    by_task.add('preload')
  }
  return by_task
}

/**
 * Work waiting behind an explicit configuration gate, errors still present on the runner,
 * and unresolved findings. Cumulative failures and completed ledger rows are historical.
 */
export function run_issues(status: AdminBackgroundStatus): RunIssue[] {
  const task_issues = new Map<string, RunIssue>()
  const blockers = new Map(Object.entries(status.blocked ?? {}))
  for (const ledger of status.database.ledgers) {
    const reason = blockers.get(ledger.id) ?? (status.mode === 'disabled' ? 'disabled' : null)
    if (! reason)
      continue
    const { pending } = task_backlog(ledger.groups)
    if (! pending)
      continue
    const name = task_names.get(ledger.id) ?? ledger.id
    const detail = reason === 'unconfigured' ? '存储服务配置不完整' : '任务已停用'
    task_issues.set(ledger.id, {
      id: `blocked-${ledger.id}`, kind: 'blocked', task_error: false, title: `${name}被阻塞`,
      detail: `${pending} 项待处理，${detail}`,
    })
  }
  for (const runner of status.process?.adapters ?? []) {
    if (! runner.last_error_code)
      continue
    const name = task_names.get(runner.id) ?? runner.id
    const shutdown = runner.last_error_code === 'shutdown_timeout'
    const existing = task_issues.get(runner.id)
    if (existing) {
      existing.task_error = true
      continue
    }
    task_issues.set(runner.id, {
      id: `failed-${runner.id}`, kind: 'failed', task_error: true, title: shutdown ? `${name}停止超时` : `${name}上次扫描出错`,
      detail: shutdown ? '关闭进程时未能按时结束' : after_failure[runner.phase],
      last_failed_at: shutdown ? undefined : runner.last_finished_at ?? undefined,
    })
  }
  for (const id of pending_errors(status)) {
    const existing = task_issues.get(id)
    if (existing) {
      existing.task_error = true
      continue
    }
    const name = task_names.get(id) ?? id
    task_issues.set(id, {
      id: `failed-${id}`, kind: 'failed', task_error: true, title: `${name}遇到错误`,
      detail: id === 'storage_audit' ? '本轮检查尚未完成' : '还有待办未完成',
    })
  }
  const issues = [... task_issues.values()]
  const open_findings = status.database.storage_audit_findings.filter(finding => finding.total > 0)
    .map(finding => ({ finding, kind: storage_audit_kind(finding.kind) }))
    .sort((a, b) => audit_priority[a.kind.type] - audit_priority[b.kind.type] || a.finding.kind.localeCompare(b.finding.kind))
  for (const { finding } of open_findings) {
    issues.push({
      id: `audit-${finding.kind}`, kind: 'audit', finding_kind: finding.kind, task_error: false, title: finding_titles.get(finding.kind) ?? '其他存储异常',
      detail: `各存储桶共 ${finding.total} 项未关闭`,
    })
  }
  return issues
}
