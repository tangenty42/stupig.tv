<template>
  <section class="run-details min-w-0" :aria-labelledby="heading_id">
    <h2 :id="heading_id" class="mb-4">
      仪表盘
    </h2>
    <div ref="layout" class="run-columns grid min-w-0 items-start gap-3 md:grid-cols-2">
      <MyAdminRunTaskDetails :status="status" :stale="stale" />
      <MyAdminRunDetailCard ref="storage" title="存储审计" icon="lucide:hard-drive" :subtitle="stale ? '状态更新中断' : audit_summary">
        <p v-if="stale" class="run-note">
          等待读取最新的检查进度和异常数
        </p>
        <template v-else>
          <div v-if="targets.length" class="divide-y divide-slate-200 dark:divide-slate-700">
            <div v-for="target in targets" :key="target.destination_id" class="py-3 first:pt-0 last:pb-0">
              <h4 v-if="targets.length > 1" class="mb-2 text-sm font-semibold">
                存储桶 {{ target.destination_id.slice(0, 8) }}
              </h4>
              <dl class="audit-counts mb-3 grid grid-cols-2 gap-2">
                <div><dt>已核对引用</dt><dd>{{ count.format(target.references_checked) }}</dd></div>
                <div><dt>已核对存储对象</dt><dd>{{ count.format(target.objects_checked) }}</dd></div>
              </dl>
              <dl class="run-facts border-t border-slate-200 pt-2 dark:border-slate-700">
                <div>
                  <dt>检查阶段</dt><dd :class="{ 'text-rose-700 dark:text-rose-300': target.error_code }">
                    {{ audit_phase_label(target.phase, !! target.error_code) }}
                  </dd>
                </div>
                <div><dt>本轮开始</dt><dd><time v-if="target.cycle_started_at" :datetime="target.cycle_started_at">{{ relative_time(target.cycle_started_at, true) }}</time><span v-else>—</span></dd></div>
                <div><dt>上次完成</dt><dd><time v-if="target.last_completed_at" :datetime="target.last_completed_at">{{ relative_time(target.last_completed_at, true) }}</time><span v-else>尚未完成</span></dd></div>
              </dl>
            </div>
          </div>
          <dl v-if="targets.length || findings.length" class="run-facts mt-1">
            <div>
              <dt>{{ targets.length > 1 ? '全部存储桶未关闭异常' : '未关闭异常' }}</dt>
              <dd v-if="findings.length">
                {{ findings.map(item => `${item.total} 项${item.name}`).join('、') }}
              </dd>
              <dd v-else>
                {{ audit_complete_once ? '0 项' : '待首次检查完成' }}
              </dd>
            </div>
          </dl>
        </template>
      </MyAdminRunDetailCard>
      <MyAdminRunDetailCard title="当前进程" icon="lucide:cpu" :subtitle="stale ? '状态更新中断' : process_summary">
        <p v-if="stale" class="run-note">
          等待读取应答进程的最新指标
        </p>
        <template v-else>
          <dl class="run-facts">
            <div><dt>已运行</dt><dd>{{ uptime }}</dd></div>
            <div><dt>常驻内存</dt><dd>{{ memory }}</dd></div>
            <div><dt>累计 CPU 时间</dt><dd>{{ process_duration(status.resources.cpu_user_ms + status.resources.cpu_system_ms) }}</dd></div>
          </dl>
          <section v-if="quotas.length" :aria-labelledby="quota_heading" class="mt-3 border-t border-slate-200 pt-3 dark:border-slate-700">
            <div class="mb-1 flex items-baseline justify-between gap-2">
              <span :id="quota_heading" class="quota-heading text-xs text-slate-600 dark:text-slate-400">
                后台并发名额
              </span>
              <span class="quota-heading text-xs text-slate-600 dark:text-slate-400">已用 / 上限</span>
            </div>
            <div v-for="([name, quota]) in quotas" :key="name" class="quota">
              <span>{{ quota_names.get(name) ?? name }}</span>
              <ProgressBar
                v-if="quota.capacity > 0" :value="Math.min(100, 100 * quota.used / quota.capacity)" :show-value="false"
                :aria-label="`${quota_names.get(name) ?? name}并发占用`" :aria-valuetext="`已用 ${quota.used}，容量 ${quota.capacity}`"
                :dt="{ height: '0.375rem' }"
              />
              <span class="col-start-3 text-right tabular-nums">{{ quota.used }} / {{ quota.capacity }}</span>
            </div>
          </section>
          <p v-if="status.mode !== 'app'" class="run-note mt-2">
            {{ admin_runner_modes[status.mode] }}
          </p>
          <p v-if="status.process?.closed" class="mt-2 text-sm text-amber-700 dark:text-amber-300">
            执行器正在关闭
          </p>
        </template>
      </MyAdminRunDetailCard>
      <MyAdminRunTimingDetails :observations="status.observations" :stale="stale" />
    </div>
  </section>
</template>

<script setup lang="ts">
import type { AdminBackgroundStatus } from '~/features/admin/status'
import { admin_runner_modes, useAdminRelativeTime } from '~/features/admin/status'
import { storage_audit_kind } from '~/features/admin/storage-audit'
import { duration_format } from '~/utils/time'

const props = defineProps<{ status: AdminBackgroundStatus, stale?: boolean }>()
const heading_id = useId()
const quota_heading = useId()
const storage = useTemplateRef('storage')
const layout = useTemplateRef('layout')
const relative_time = useAdminRelativeTime()
const count = new Intl.NumberFormat('zh-CN')
const process_duration = (ms: number) => duration_format(ms, { expand: true, timezone: 'UTC' }).trim()
const uptime = computed(() => process_duration(props.status.resources.uptime_seconds * 1000))
const memory = computed(() => format_bytes(props.status.resources.rss_bytes))
const process_summary = computed(() => `已运行 ${uptime.value}，常驻内存 ${memory.value}`)
const quota_names = new Map(Object.entries({ image: '图片处理', oss: '对象存储', esa: '边缘服务', notification: '同步通知' }))
const quotas = computed(() => Object.entries(props.status.process?.resources ?? {}))
const targets = computed(() => props.status.database.storage_audit)
const findings = computed(() => props.status.database.storage_audit_findings.filter(item => item.total > 0)
  .map(item => ({ ... item, ... storage_audit_kind(item.kind) })))
const audit_complete_once = computed(() => targets.value.length > 0 && targets.value.every(target => target.last_completed_at))
const phases = new Map(Object.entries({
  attachments: '核对附件引用', avatars: '核对头像引用', static: '核对静态文件',
  objects: '核对存储对象', findings: '复核异常', completed: '本轮已完成',
}))

function audit_phase_label(phase: string, failed: boolean) {
  const label = phases.get(phase)
  if (! failed)
    return label ?? phase
  return label && phase !== 'completed' ? `${label}时出错` : '存储检查出错'
}

const audit_summary = computed(() => {
  const active = targets.value.filter(target => target.phase !== 'completed')
  const first = active[0]
  let progress = '尚无存储桶检查记录'
  if (active.length > 1) {
    progress = `${active.length} 个存储桶正在检查`
  }
  else if (first) {
    progress = first.last_completed_at ? '正在检查' : '首次检查中'
  }
  else if (audit_complete_once.value) {
    const latest = targets.value.reduce((time, target) => target.last_completed_at && target.last_completed_at > time ? target.last_completed_at : time, '')
    progress = `${relative_time(latest, true)} 完成检查`
  }
  const total = findings.value.reduce((sum, item) => sum + item.total, 0)
  return total || audit_complete_once.value ? `${progress}，${total} 项异常未关闭` : progress
})

function showStorage() {
  storage.value?.focusHeading()
}
defineExpose({ showStorage })

// Keep each card mounted and in reading order while its height animates or the viewport changes.
let observer: ResizeObserver | undefined
onMounted(() => {
  const grid = layout.value!
  const cards = Array.from(grid.children, child => child as HTMLElement)
  function pack() {
    const heights = cards.map(card => card.getBoundingClientRect().height)
    const gap = Number.parseFloat(getComputedStyle(grid).rowGap) || 0
    const bottoms: [number, number] = [0, 0]
    for (const [index, card] of cards.entries()) {
      const column = bottoms[0] <= bottoms[1] ? 0 : 1
      card.style.setProperty('--run-column', String(column + 1))
      card.style.setProperty('--run-offset', `${bottoms[column]}px`)
      bottoms[column] += heights[index]! + gap
    }
  }
  pack()
  grid.dataset.packed = ''
  observer = new ResizeObserver(pack)
  for (const card of cards)
    observer.observe(card, { box: 'border-box' })
})
onBeforeUnmount(() => observer?.disconnect())
</script>

<style scoped>
.run-details { overflow-wrap: anywhere; }
@media (min-width: 768px) {
  .run-columns[data-packed] > :deep(.p-card) {
    grid-row: 1;
    grid-column: var(--run-column);
    margin-top: var(--run-offset);
  }
}
.run-details :deep(.run-note), .audit-counts dt { @apply text-xs font-normal text-slate-500 dark:text-slate-400; }
.audit-counts div { @apply flex flex-col-reverse; }
.audit-counts dd { @apply text-2xl font-semibold leading-tight text-slate-900 tabular-nums dark:text-slate-100 sm:text-3xl; }
.run-facts > div { @apply flex items-baseline justify-between gap-x-3 py-1.5 text-sm; }
.run-facts dt, .quota > span:first-child { @apply shrink-0 text-slate-600 dark:text-slate-400; }
.run-facts dd { @apply text-right font-medium tabular-nums; }
.run-facts, .quota { @apply text-slate-700 dark:text-slate-300; }
.quota { @apply mt-1.5 grid grid-cols-[minmax(4rem,auto)_minmax(1rem,1fr)_auto] items-center gap-x-2 text-sm; }

.run-details :deep(.run-brief-table) {
  --p-datatable-header-cell-background: transparent;
  --p-datatable-row-background: transparent;
  @apply text-slate-700 dark:text-slate-300;
  --p-datatable-row-color: inherit;
}
.run-details :deep(.run-brief-table th), .run-details :deep(.run-brief-table td) { @apply px-1 py-1.5 align-middle text-sm tabular-nums; }
.run-details :deep(.run-brief-table th) { @apply border-0 pt-0 text-xs text-slate-600 dark:text-slate-400; }
/* Column titles get their weight from the theme token (600); the quota header reuses it directly. */
.quota-heading { font-weight: var(--p-datatable-column-title-font-weight, 600); }
.run-details :deep(.run-brief-table th:first-child), .run-details :deep(.run-brief-table td:first-child) { @apply pl-0; }
.run-details :deep(.run-brief-table th:last-child), .run-details :deep(.run-brief-table td:last-child) { @apply pr-0 text-right; }
.run-details :deep(.run-brief-table th:last-child .p-datatable-column-header-content) { @apply justify-end; }
.run-details :deep(.run-brief-table tr:last-child td) { @apply border-0; }
.run-details :deep(.run-timing-table th:not(:first-child)), .run-details :deep(.run-timing-table td:not(:first-child)) { @apply text-right; }
.run-details :deep(.run-timing-table th:not(:first-child) .p-datatable-column-header-content) { @apply justify-end; }
</style>
