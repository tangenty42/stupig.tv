import { settings } from '@shared/settings'
import { duration_build_string } from '~/utils/time'

export type AdminBackgroundStatus = Awaited<ReturnType<ReturnType<typeof useApi>['admin']['get_background_status']>>
export type AdminTaskLedger = AdminBackgroundStatus['database']['ledgers'][number]
export type AdminTaskRunner = NonNullable<AdminBackgroundStatus['process']>['adapters'][number]
export type AdminStageObservation = AdminBackgroundStatus['observations'][number]
export type AdminBadgeType = 'info' | 'success' | 'warning' | 'error'

/** Display order and names; the ids are the server's background adapter ids. */
export const admin_tasks = [
  { id: 'images', name: '图片处理' },
  { id: 'uploads', name: '上传收尾' },
  { id: 'retirement', name: '存储对象清理' },
  { id: 'preload', name: '边缘预热' },
  { id: 'sync', name: '同步通知' },
  { id: 'receipts', name: '回执压缩' },
  { id: 'storage_audit', name: '存储审计' },
]

export const admin_runner_modes: Record<AdminBackgroundStatus['mode'], string> = {
  app: '随应用运行',
  worker: '后台由独立进程运行',
  disabled: '后台任务已停用',
}

/** Background status for the console; fetched in the browser only and polled while the tab is visible. */
export function useAdminBackgroundStatus() {
  const { admin } = useApi()
  const { error: toast_error } = useMyToast()
  const status = ref<AdminBackgroundStatus | null>(null)
  const loading = ref(false)
  const updated_at = ref<Date | null>(null)
  const stale = ref(false)
  const ready = useSyncedData(null, () => admin.get_background_status(), status, loading, {
    server: false,
    share: false,
    fetch_without_resource: true,
    polling_interval: settings.app.admin.statusPollIntervalSeconds * 1000,
    on_data: (value) => {
      if (value) {
        updated_at.value = new Date()
        stale.value = false
      }
    },
    on_error: () => {
      if (stale.value)
        return
      stale.value = true
      toast_error('WTF，运行状态更新失败？！')
    },
  }).then(() => undefined)
  return { status, updated_at, stale, ready }
}

/**
 * Relative time against the shared clock. `precise` keeps seconds, which matter for sweeps that run every
 * few seconds; a moment still ahead reads as "…后". A sub-second difference is clock noise — the suffix
 * would flip between 前/后 on every tick — so it reads as "刚刚".
 */
export function useAdminRelativeTime() {
  const time_context = useDisplayTimeContext()
  const date_now = useReactiveDateNow()
  return (time: string, precise = false) => {
    const suffix = date_now.value.isBefore(time) ? '后' : '前'
    if (precise && Math.abs(date_now.value.diff(time)) < 1000)
      return '刚刚'
    const template: string | [string, string] = precise ? `{formated_expand}${suffix}` : [`{formated}${suffix}`, suffix === '后' ? '马上' : '刚刚']
    return duration_build_string([time, date_now.value], template, { timezone: time_context.value.timezone }).trim()
  }
}

/** One card per known task in display order, then any task the server reports that this build has no name for. */
export function task_cards(status: Pick<AdminBackgroundStatus, 'process' | 'database'>) {
  const ledgers = new Map(status.database.ledgers.map(ledger => [ledger.id, ledger]))
  const runners = new Map(status.process?.adapters.map(adapter => [adapter.id, adapter]))
  const ids = new Set([... ledgers.keys(), ... runners.keys()])
  for (const task of admin_tasks)
    ids.delete(task.id)
  const unnamed = [... ids].map(id => ({ id, name: id }))
  return [... admin_tasks, ... unnamed].map(task => ({
    task,
    ledger: ledgers.get(task.id) ?? null,
    runner: runners.get(task.id) ?? null,
  }))
}

/** Totals over one task's ledger groups, with the oldest pending time among them. */
export function task_backlog(groups: AdminTaskLedger['groups']) {
  const total = { pending: 0, due: 0, leased: 0, oldest_pending_at: null as string | null }
  for (const group of groups) {
    total.pending += group.pending
    total.due += group.due
    total.leased += group.leased
    // Both sides are ISO 8601 UTC strings, so string order is time order.
    if (group.oldest_pending_at && (! total.oldest_pending_at || group.oldest_pending_at < total.oldest_pending_at))
      total.oldest_pending_at = group.oldest_pending_at
  }
  return total
}
