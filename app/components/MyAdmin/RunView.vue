<template>
  <div class="space-y-8 sm:space-y-12">
    <slot name="header" :updated_at="updated_at" />
    <MyAdminRunIssues
      :status="status"
      :stale="stale"
      :can-read-findings="can_read_findings"
      @show-storage="show_findings"
    />
    <MyAdminRunDetails v-if="status" ref="details" :status="status" :stale="stale" />
    <MyAdminSectionCard v-if="can_read_findings" ref="findings_section" title="异常明细">
      <div v-if="! findings_request" class="py-8 text-center">
        <p class="text-sm text-slate-500 dark:text-slate-400">
          按需读取当前存储桶的未关闭异常
        </p>
        <Button label="读取异常明细" severity="secondary" outlined size="small" class="mt-3" @click="show_findings()" />
      </div>
      <MyAdminStorageFindings v-else ref="findings_view" :initial-kind="findings_request.kind" :available-kinds="available_kinds" />
    </MyAdminSectionCard>
  </div>
</template>

<script setup lang="ts">
import { has_permission } from '@shared/permissions'
import { useAdminBackgroundStatus } from '~/features/admin/status'

const props = defineProps<{ focusStorage: boolean }>()
const { user } = useAuth()
const background_status = useAdminBackgroundStatus()
const { status, updated_at, stale } = background_status
const can_read_findings = computed(() => has_permission(user.value, 'admin_access', 'readonly'))
const available_kinds = computed(() => status.value?.database.storage_audit_findings.filter(item => item.total > 0).map(item => item.kind) ?? [])
const findings_request = ref<{ kind?: string }>()
const findings_section = useTemplateRef('findings_section')
const findings_view = useTemplateRef('findings_view')
const details = useTemplateRef('details')

watch(can_read_findings, (allowed) => {
  if (! allowed)
    findings_request.value = undefined
})

// The old storage address can arrive before the initial status request finishes.
watch([() => props.focusStorage, details], ([focused, view]) => {
  if (focused)
    view?.showStorage()
}, { flush: 'post' })

// Holds the previous view during a client-side switch. Skipped while hydrating: the first snapshot is
// only requested in the browser, so the page has to hydrate against the SSR markup and refetch.
if (! useNuxtApp().isHydrating)
  await background_status.ready

function show_findings(kind?: string) {
  if (! can_read_findings.value)
    return
  // The heading stays mounted while a new category loads, including during slow requests.
  findings_section.value?.focusHeading()
  if (findings_view.value)
    void findings_view.value.showKind(kind)
  else
    findings_request.value = { kind }
}
</script>
