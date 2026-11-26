<template>
  <div>
    <div v-if="! forbidden && kind_options.length" role="group" aria-label="按异常类型筛选" class="mb-4 flex flex-wrap items-center gap-1.5">
      <button
        v-for="kind in kind_options" :key="kind.id" type="button" class="rounded-full"
        :aria-pressed="selected_kinds.includes(kind.id)" @click="toggle_kind(kind.id)"
      >
        <MyBadge :type="kind.type" :outlined="! selected_kinds.includes(kind.id)" button>
          {{ kind.name }}
        </MyBadge>
      </button>
      <button v-if="selected_kinds.length" type="button" class="rounded-full" @click="select_kinds([])">
        <MyBadge button>
          清除
        </MyBadge>
      </button>
    </div>
    <div class="mb-4 flex flex-wrap items-center justify-between gap-3">
      <p class="flex flex-wrap items-baseline gap-x-2 text-xs text-slate-500 dark:text-slate-400">
        <span><MyIcon name="lucide:refresh-cw" class="mr-1" aria-hidden="true" />手动更新</span>
        <span><time v-if="updated_at" :datetime="updated_at.toISOString()">{{ relative_time(updated_at.toISOString(), true) }} 更新</time><span v-else>—</span></span>
      </p>
      <Button
        severity="secondary" outlined :disabled="loading" label="刷新" size="small"
        class="ml-auto whitespace-nowrap !border-slate-300 !font-medium !text-slate-700 dark:!border-slate-600 dark:!text-slate-300" @click="refresh()"
      >
        <template #icon>
          <MyIcon name="lucide:refresh-cw" />
        </template>
      </Button>
    </div>
    <div ref="results" :aria-busy="loading" :style="loading && ! findings && previous_height ? { minHeight: `${previous_height}px` } : undefined">
      <Paginator
        v-if="total" aria-label="异常明细分页" class="mb-3"
        :first="first_record_index"
        :rows="page_size"
        :total-records="total"
        :rows-per-page-options="storage_audit_page_sizes"
        :pt="{ content: { class: 'min-w-0 flex-wrap justify-center' }, pages: { class: 'flex-wrap' } }"
        template="CurrentPageReport PrevPageLink PageLinks NextPageLink RowsPerPageDropdown"
        current-page-report-template="{first} ~ {last} / {totalRecords}"
        @page="change_page"
      />

      <div v-if="! findings && ! stale" class="divide-y divide-slate-200 dark:divide-slate-700" aria-hidden="true">
        <div v-for="index in 3" :key="index" class="py-3.5">
          <div class="flex h-5 items-center">
            <Skeleton width="12rem" height="1rem" class="max-w-full" />
          </div>
          <div class="mt-1.5 flex flex-wrap items-center gap-1.5">
            <Skeleton width="6rem" height="1.625rem" class="rounded-full" />
            <Skeleton width="4rem" height="1.625rem" class="rounded-full" />
            <Skeleton width="10rem" height="1.625rem" class="rounded-full" />
          </div>
        </div>
      </div>
      <ul v-else-if="rows.length" aria-label="对象异常记录" class="divide-y divide-slate-200 dark:divide-slate-700">
        <li v-for="row in rows" :key="row.finding.id" class="py-3.5">
          <code class="block select-all break-all text-sm font-semibold text-slate-900 dark:text-slate-100">{{ row.finding.object_key }}</code>
          <div class="mt-1.5 flex flex-wrap items-center gap-1.5">
            <MyBadge :type="row.kind.type" :outlined="! selected_kinds.includes(row.finding.kind)">
              {{ row.kind.name }}
            </MyBadge>
            <MyBadge type="info" outlined>
              发现 {{ row.finding.observations }} 次
            </MyBadge>
            <MyBadge type="info" outlined>
              <span>首次 <time :datetime="row.finding.first_seen_at">{{ relative_time(row.finding.first_seen_at) }}</time>，最近 <time :datetime="row.finding.last_seen_at">{{ relative_time(row.finding.last_seen_at) }}</time></span>
            </MyBadge>
            <MyBadge v-if="row.sizes" type="info" outlined class="tabular-nums">
              {{ row.sizes }}
            </MyBadge>
          </div>
        </li>
      </ul>
      <div v-else-if="findings && ! stale" class="py-8 text-center text-sm text-slate-500 dark:text-slate-400">
        {{ selected_kinds.length ? '当前存储桶没有所选类型的未关闭异常' : '当前存储桶没有未关闭的异常' }}
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useAdminRelativeTime } from '~/features/admin/status'
import { finding_sizes, storage_audit_kind, storage_audit_page_sizes, useAdminStorageFindings } from '~/features/admin/storage-audit'

const props = defineProps<{ initialKind?: string, availableKinds: string[] }>()
const {
  findings, loading, updated_at, stale, forbidden, total, known_kinds,
  selected_kinds, page_size, first_record_index, change_page, select_kinds, toggle_kind, refresh,
} = useAdminStorageFindings(props.initialKind)
const results = useTemplateRef('results')
const previous_height = ref(0)

// Measure before the rows give way to the skeleton. The section animates to the final height.
watch(loading, (pending) => {
  if (pending)
    previous_height.value = results.value?.getBoundingClientRect().height ?? 0
})

const relative_time = useAdminRelativeTime()
const kind_options = computed(() => [... new Set([... props.availableKinds, ... known_kinds.value, ... selected_kinds.value])]
  .map(id => ({ id, ... storage_audit_kind(id) })))

const rows = computed(() => (findings.value ?? []).map(finding => ({
  finding,
  kind: storage_audit_kind(finding.kind),
  sizes: finding_sizes(finding),
})))

defineExpose({ showKind: (kind?: string) => select_kinds(kind ? [kind] : []) })
</script>
