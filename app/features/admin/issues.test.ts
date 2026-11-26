import type { AdminBackgroundStatus, AdminTaskLedger, AdminTaskRunner } from './status'
import { expect, it } from 'vitest'
import { run_issues } from './issues'

const group = { phase: 'queued', error_code: null, total: 4, pending: 4, due: 3, leased: 0, oldest_pending_at: '2026-11-20T02:10:00Z' }
const runner: AdminTaskRunner = { id: 'images', phase: 'running', runs: 13, failures: 2, last_error_code: 'sweep_failed',
  last_started_at: '2026-11-20T02:42:00Z', last_finished_at: '2026-11-20T02:41:05Z', last_duration_ms: null }

function status(ledgers: AdminTaskLedger[] = [], adapters: AdminTaskRunner[] = []): AdminBackgroundStatus {
  return { mode: 'app', blocked: {}, process: { closed: false, resources: {}, adapters },
    database: { ledgers, preload_targets: [], storage_audit: [], storage_audit_findings: [] }, observations: [],
    resources: { uptime_seconds: 15, rss_bytes: 0, heap_used_bytes: 0, external_bytes: 0, cpu_user_ms: 0, cpu_system_ms: 0 } }
}

it('reports blocked work, last-run errors and aggregate open findings in that order', () => {
  const value = status([{ id: 'retirement', groups: [group], interval_seconds: 30 }], [runner])
  value.blocked.retirement = 'unconfigured'
  value.database.storage_audit_findings = [{ kind: 'orphan_candidate', total: 1 }, { kind: 'missing_object', total: 4 }, { kind: 'size_mismatch', total: 0 }]
  const issues = run_issues(value)
  expect(issues.map(issue => issue.id)).toEqual(['blocked-retirement', 'failed-images', 'audit-missing_object', 'audit-orphan_candidate'])
  expect(issues[0]).toMatchObject({ detail: '4 项待处理，存储服务配置不完整', task_error: false })
  expect(issues[1]).toMatchObject({ last_failed_at: runner.last_finished_at, detail: '本轮正在运行', task_error: true })
  expect(issues[2]).toMatchObject({ finding_kind: 'missing_object', detail: '各存储桶共 4 项未关闭' })
})

it('ignores past failures and normal disabled gates without waiting work', () => {
  const value = status([{ id: 'retirement', groups: [{ ... group, phase: 'failed', pending: 0, due: 0, error_code: 'old_failure' }], interval_seconds: 60 }], [{ ... runner, last_error_code: null }])
  value.blocked = { retirement: 'disabled', preload: 'unconfigured' }
  value.mode = 'disabled'
  expect(run_issues(value)).toEqual([])
  value.database.ledgers[0]!.groups = [group]
  expect(run_issues(value).map(issue => issue.id)).toEqual(['blocked-retirement'])
  value.blocked = {}
  value.process = null
  expect(run_issues(value)[0]?.detail).toBe('4 项待处理，任务已停用')
  value.mode = 'worker'
  expect(run_issues(value)).toEqual([])
  value.database.ledgers[0]!.id = 'toString'
  expect(run_issues(value)).toEqual([])
})

it('keeps shutdown timeouts separate from previous sweep completion times', () => {
  const value = status([], [{ ... runner, last_error_code: 'shutdown_timeout' }])
  const [issue] = run_issues(value)
  expect(issue).toMatchObject({ title: '图片处理停止超时', detail: '关闭进程时未能按时结束', task_error: true })
  expect(issue?.last_failed_at).toBeUndefined()
})

it('reports unresolved job and bucket errors when the runner lives elsewhere', () => {
  const value = status([
    { id: 'retirement', groups: [{ ... group, error_code: 'origin_delete_failed' }], interval_seconds: 30 },
    { id: 'storage_audit', groups: [{ ... group, error_code: 'oss_access_denied' }], interval_seconds: 30 },
    { id: 'preload', groups: [group], interval_seconds: 30 },
  ])
  value.process = null
  value.mode = 'worker'
  value.database.storage_audit = [{ destination_id: 'abc12345hidden', phase: 'objects', error_code: 'oss_access_denied',
    cycle_started_at: null, last_completed_at: null, next_run_at: null, references_checked: 5, objects_checked: 1 }]
  value.database.preload_targets = [{ total: 1, leased: 0, error_code: 'permission_denied' }]
  const issues = run_issues(value)
  expect(issues.map(issue => issue.id)).toEqual(['failed-retirement', 'failed-storage_audit', 'failed-preload'])
  expect(issues.every(issue => issue.task_error)).toBe(true)
  expect(issues[1]?.detail).toBe('本轮检查尚未完成')
})

it('counts a task once and ignores normal protection and throttling waits', () => {
  const value = status([
    { id: 'retirement', groups: [{ ... group, error_code: 'origin_delete_failed' }], interval_seconds: 30 },
    { id: 'preload', groups: [{ ... group, error_code: 'queue_full' }], interval_seconds: 30 },
  ], [{ ... runner, id: 'retirement' }])
  value.blocked.retirement = 'unconfigured'
  value.database.preload_targets = [{ total: 1, leased: 0, error_code: 'budget_exhausted' }]
  const issues = run_issues(value)
  expect(issues.map(issue => issue.id)).toEqual(['blocked-retirement'])
  expect(issues[0]?.task_error).toBe(true)
  value.blocked = {}
  value.process = null
  value.database.ledgers[0]!.groups = [{ ... group, error_code: 'object_referenced' }]
  expect(run_issues(value)).toEqual([])
})
