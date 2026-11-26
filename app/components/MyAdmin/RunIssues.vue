<template>
  <section :aria-labelledby="overview_heading">
    <h2 :id="overview_heading" class="sr-only">
      异常概况
    </h2>
    <div role="group" aria-label="异常概况" class="grid grid-cols-3 gap-1.5 sm:gap-3">
      <Card
        v-for="metric in metrics" :key="metric.kind" class="metric" :class="[metric.kind, { 'has-issues': metric.value, 'unknown': metric.value === null }]"
        :pt="{ body: { class: '!px-2 !py-2.5 sm:!px-4 sm:!py-3' } }"
      >
        <template #content>
          <MyHeightTransition>
            <dl>
              <dt class="text-xs font-medium text-slate-700 dark:text-slate-300 sm:text-sm">
                <MyIcon :name="metric.icon" aria-hidden="true" class="metric-icon me-1 sm:me-1.5" />
                {{ metric.label }}
              </dt>
              <dd class="mt-2 flex flex-wrap items-baseline gap-x-1.5 gap-y-1">
                <strong
                  class="min-w-0 max-w-full break-all font-medium leading-none tabular-nums"
                  :class="(metric.value ?? 0) >= 100000 ? 'text-xl sm:text-3xl' : 'text-2xl sm:text-4xl'"
                >{{ metric.value ?? '—' }}</strong>
                <span class="whitespace-nowrap text-xs text-slate-500 dark:text-slate-400">{{ metric.unit }}</span>
              </dd>
            </dl>
          </MyHeightTransition>
        </template>
      </Card>
    </div>
  </section>

  <section :aria-labelledby="issues_heading">
    <h2 :id="issues_heading" class="mb-4">
      TODO
    </h2>
    <MyHeightTransition>
      <p v-if="! stale && ! status" role="status" class="text-sm text-slate-500 dark:text-slate-400">
        正在读取运行状态……
      </p>
      <div v-else-if="! stale && status" class="space-y-3">
        <ul v-if="issues.length" class="space-y-3">
          <li v-for="issue in issues" :key="issue.id" class="issue-card flex items-center justify-between gap-2 rounded-sm border border-l-[3px] border-slate-200 bg-white/80 py-3 pl-4 pr-3 shadow-sm dark:border-slate-700 dark:bg-slate-900/50 sm:gap-4" :class="issue.kind">
            <div class="min-w-0 break-words">
              <h3 class="font-semibold text-slate-900 dark:text-slate-100">
                {{ issue.title }}
              </h3>
              <p class="mt-0.5 text-sm text-slate-600 dark:text-slate-400">
                <span v-if="issue.last_failed_at">
                  <time :datetime="issue.last_failed_at">{{ relative_time(issue.last_failed_at, true) }}</time>的扫描失败，
                </span>{{ issue.detail }}<span v-if="issue.kind === 'blocked' && issue.task_error">，另有错误记录</span>
              </p>
            </div>
            <Button
              v-if="issue.kind === 'audit' && canReadFindings"
              :aria-label="`查看明细：${issue.title}`"
              severity="secondary" outlined size="small" class="shrink-0"
              @click="$emit('show-storage', issue.finding_kind)"
            >
              <MyIcon name="lucide:file-search" aria-hidden="true" />
              <span>查看<span class="hidden min-[400px]:inline">明细</span></span>
            </Button>
          </li>
        </ul>
        <p v-else-if="status.process && ! audit_pending" class="text-sm text-slate-500 dark:text-slate-400">
          暂未发现异常
        </p>
        <p v-if="! status.process || audit_pending" class="text-sm text-slate-500 dark:text-slate-400">
          <span v-if="! status.process">没有本机运行记录{{ audit_pending ? '，' : '' }}</span>
          <span v-if="audit_pending">{{ status.database.storage_audit.length ? '部分存储桶尚未完成首次检查' : '还没有存储审计记录' }}</span>
        </p>
      </div>
    </MyHeightTransition>
  </section>
</template>

<script setup lang="ts">
import type { AdminBackgroundStatus } from '~/features/admin/status'
import { run_issues } from '~/features/admin/issues'
import { useAdminRelativeTime } from '~/features/admin/status'

const props = defineProps<{ status: AdminBackgroundStatus | null, stale: boolean, canReadFindings: boolean }>()
defineEmits<{ 'show-storage': [kind: string] }>()
const relative_time = useAdminRelativeTime()
const overview_heading = useId()
const issues_heading = useId()

const issues = computed(() => props.status && ! props.stale ? run_issues(props.status) : [])
const audit_total = computed(() => props.status?.database.storage_audit_findings.reduce((total, finding) => total + finding.total, 0) ?? 0)
const audit_pending = computed(() => ! props.status?.database.storage_audit.length || props.status.database.storage_audit.some(target => ! target.last_completed_at))
const metrics = computed(() => {
  const fresh = !! props.status && ! props.stale
  const failures = issues.value.filter(issue => issue.task_error).length
  return [
    { kind: 'blocked', icon: 'lucide:circle-pause', label: '任务阻塞', unit: '项任务', value: fresh ? issues.value.filter(issue => issue.kind === 'blocked').length : null },
    { kind: 'failed', icon: 'lucide:zap', label: '任务出错', unit: '项任务', value: fresh && (failures > 0 || props.status?.process) ? failures : null },
    { kind: 'audit', icon: 'lucide:database', label: '存储异常', unit: '项未关闭', value: fresh && (audit_total.value > 0 || ! audit_pending.value) ? audit_total.value : null },
  ]
})
</script>

<style scoped>
.metric { @apply min-w-0 rounded-sm border border-slate-200 bg-slate-50 text-slate-700 shadow-sm dark:border-slate-700 dark:bg-slate-800/50 dark:text-slate-300; }
.metric-icon, .unknown strong { @apply text-slate-500 dark:text-slate-400; }
.has-issues strong { @apply font-semibold text-slate-900 dark:text-slate-100; }
.has-issues.blocked .metric-icon { @apply text-amber-700 dark:text-amber-400; }
.has-issues.failed .metric-icon { @apply text-rose-700 dark:text-rose-400; }
.has-issues.audit .metric-icon { @apply text-cyan-700 dark:text-cyan-400; }
.issue-card.blocked { @apply border-l-amber-500 dark:border-l-amber-400; }
.issue-card.failed { @apply border-l-rose-500 dark:border-l-rose-400; }
.issue-card.audit { @apply border-l-cyan-600 dark:border-l-cyan-300; }
</style>
