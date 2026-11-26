<template>
  <MyAdminRunDetailCard title="后台任务" icon="lucide:list-checks" :subtitle="stale ? '状态更新中断' : task_summary">
    <p v-if="stale" class="run-note">
      等待读取最新的待办数和运行情况
    </p>
    <DataTable
      v-else :value="rows" data-key="id" size="small" class="run-brief-table"
      table-class="w-full table-fixed" :table-props="{ 'aria-label': '后台任务与执行记录' }"
    >
      <Column field="name" header="任务" header-class="w-[39%]" body-class="font-medium" />
      <Column header="待办" header-class="w-[19%]">
        <template #body="{ data }">
          <span v-if="data.backlog" :class="data.backlog.pending ? 'font-semibold text-slate-900 dark:text-slate-100' : muted">{{ data.backlog.pending }}</span>
          <span v-else aria-label="待办数未知" :class="muted">—</span>
        </template>
      </Column>
      <Column header="运行情况">
        <template #body="{ data }">
          <span :class="data.blocked && ! data.backlog?.pending ? muted : data.state.tone">{{ data.state.label }}</span>
        </template>
      </Column>
    </DataTable>
  </MyAdminRunDetailCard>
</template>

<script setup lang="ts">
import type { AdminBackgroundStatus, AdminTaskRunner } from '~/features/admin/status'
import { pending_errors } from '~/features/admin/issues'
import { task_backlog, task_cards, useAdminRelativeTime } from '~/features/admin/status'

const props = defineProps<{ status: AdminBackgroundStatus, stale?: boolean }>()
const relative_time = useAdminRelativeTime()
const muted = 'text-slate-500 dark:text-slate-400'
const warning = 'font-medium text-amber-700 dark:text-amber-400'
const error = 'font-medium text-rose-700 dark:text-rose-400'

function task_state(id: string, runner: AdminTaskRunner | null, blocker: string | null | undefined, pending_error: boolean) {
  if (blocker === 'unconfigured')
    return { label: '配置不完整', tone: warning }
  if (blocker === 'disabled' || props.status.mode === 'disabled')
    return { label: '已停用', tone: warning }
  if (blocker)
    return { label: '已阻塞', tone: warning }
  if (runner?.last_error_code === 'shutdown_timeout')
    return { label: '停止超时', tone: error }
  if (pending_error)
    return { label: '待办出错', tone: error }
  // If a new sweep has started, the attention list still reports the previous error.
  if (runner?.phase === 'running')
    return { label: '本轮运行中' }
  if (runner?.last_error_code)
    return { label: '上次扫描出错', tone: error }
  if (runner?.phase === 'queued')
    return { label: '排队中' }
  if (id === 'storage_audit' && props.status.database.storage_audit.length && props.status.database.storage_audit.every(target => target.phase === 'completed'))
    return { label: '本轮已完成' }
  if (runner?.phase === 'idle')
    return { label: '空闲' }
  return { label: runner || props.status.mode === 'worker' ? '执行状态未知' : '无执行记录' }
}
const rows = computed(() => {
  const blockers = new Map(Object.entries(props.status.blocked ?? {}))
  const errors = pending_errors(props.status)
  return task_cards(props.status).map(({ task, ledger, runner }) => {
    const backlog = ledger ? task_backlog(ledger.groups) : null
    const blocker = blockers.get(task.id)
    const blocked = !! blocker || props.status.mode === 'disabled'
    const pending_error = errors.has(task.id)
    const failed = pending_error || !! runner?.last_error_code
    const running = runner?.phase === 'running'
    let priority = 4
    if (blocked && backlog?.pending)
      priority = 0
    else if (failed)
      priority = 1
    else if (running || runner?.phase === 'queued')
      priority = 2
    else if (backlog?.pending)
      priority = 3
    return { ... task, backlog, blocked, running, priority, state: task_state(task.id, runner, blocker, pending_error) }
  }).sort((a, b) => a.priority - b.priority)
})
const task_summary = computed(() => {
  const pending = rows.value.filter(row => row.backlog && row.backlog.pending > 0)
  const first = pending.find(row => row.blocked) ?? pending.find(row => row.backlog?.oldest_pending_at) ?? pending[0]
  if (first?.backlog) {
    const oldest = first.backlog.oldest_pending_at
    return `${first.name}有 ${first.backlog.pending} 项待办${oldest ? `，最早待办 ${relative_time(oldest)}` : ''}`
  }
  const active = rows.value.find(row => row.running)
  if (active)
    return `${active.name}正在本进程运行`
  const reported = props.status.database.ledgers.length
  return reported ? `${reported} 类任务暂无待办` : '尚无任务台账'
})
</script>
