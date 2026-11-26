<template>
  <MyAdminRunDetailCard title="处理用时" icon="lucide:timer" :subtitle="stale ? '状态更新中断' : timing_summary">
    <p v-if="stale" class="run-note">
      等待读取最新的环节用时
    </p>
    <DataTable
      v-else-if="recorded.length" :value="recorded" data-key="stage" size="small" class="run-brief-table run-timing-table"
      table-class="w-full table-fixed" :table-props="{ 'aria-label': '本进程各环节用时' }"
    >
      <Column header="环节" header-class="w-[36%]">
        <template #body="{ data }">
          <span>{{ names.get(data.stage) ?? data.stage }}</span>
          <small v-if="data.recent_count" class="run-note block">最近 {{ data.recent_count }} 次</small>
          <small v-else class="run-note block">{{ data.active ? '正在计时' : '暂无近期样本' }}</small>
        </template>
      </Column>
      <Column header="中位耗时" header-class="w-[31%]">
        <template #body="{ data }">
          {{ data.recent_p50_ms === null ? '—' : milliseconds_format(data.recent_p50_ms) }}
        </template>
      </Column>
      <Column header="P95 耗时">
        <template #body="{ data }">
          {{ data.recent_p95_ms === null ? '—' : milliseconds_format(data.recent_p95_ms) }}
        </template>
      </Column>
    </DataTable>
  </MyAdminRunDetailCard>
</template>

<script setup lang="ts">
import type { AdminStageObservation } from '~/features/admin/status'
import { milliseconds_format } from '~/utils/time'

const props = defineProps<{ observations: AdminStageObservation[], stale?: boolean }>()
const names = new Map(Object.entries({
  upload_seal: '封存上传', multipart_complete: '分片上传合并', upload_adopt: '接收上传文件', upload_adopt_commit: '提交文件接收记录',
  image_claim: '领取图片任务', image_queue: '图片排队', image_job: '图片处理', image_source_guard: '校验原图',
  image_source_info: '读取原图信息', image_display: '生成展示图', image_fallback: '生成兼容图', image_lqip: '生成占位图',
  image_final_guard: '校验处理结果', image_archive: '归档原图', image_ready_commit: '提交图片处理结果',
  sync_queue: '同步通知排队', sync_publish_ack: '发布并确认通知', db_acquire: '数据库取连接',
} satisfies Record<AdminStageObservation['stage'], string>))

function priority(item: AdminStageObservation) {
  if (item.stage === 'image_job')
    return 0
  if (item.active > 0)
    return 1
  if (item.failed > 0)
    return 2
  if (item.stage === 'multipart_complete')
    return 3
  if (item.stage === 'db_acquire')
    return 4
  return 5
}
const recorded = computed(() => props.observations.filter(item => item.count > 0 || item.active > 0).sort((a, b) => priority(a) - priority(b)))
const timing_summary = computed(() => {
  const item = recorded.value.find(item => item.recent_p50_ms !== null && item.recent_count > 0)
  if (item && item.recent_p50_ms !== null)
    return `最近 ${item.recent_count} 次${names.get(item.stage) ?? item.stage}，中位耗时 ${milliseconds_format(item.recent_p50_ms)}`
  const active = recorded.value.filter(item => item.active > 0).length
  if (active)
    return `${active} 个环节正在处理`
  return recorded.value.length ? '当前没有近期用时样本' : '本进程尚未记录环节用时'
})
</script>
