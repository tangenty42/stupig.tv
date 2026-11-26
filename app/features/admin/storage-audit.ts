import type { StorageAuditFinding, StorageAuditFindingsPage, StorageAuditFindingsQuery, StorageAuditKind } from '@shared/types/storage-audit'
import type { AdminBadgeType } from './status'
import { get_error_status } from '~/composables/useApi'
import { format_bytes } from '~/utils/size'

export const storage_audit_page_sizes = [10, 50, 100, 154800]

export const storage_audit_kinds: Record<StorageAuditKind, { name: string, type: AdminBadgeType }> = {
  missing_object: { name: '对象缺失', type: 'error' },
  size_mismatch: { name: '大小不符', type: 'error' },
  public_object: { name: '对象可公开读', type: 'error' },
  invalid_reference: { name: '引用无效', type: 'warning' },
  retired_object_present: { name: '已退役对象仍在', type: 'warning' },
  orphan_candidate: { name: '疑似无主对象', type: 'info' },
  unregistered_static: { name: '未登记的静态文件', type: 'info' },
  unmanaged_object: { name: '不归本站管的对象', type: 'info' },
}

const kinds = new Map<string, { name: string, type: AdminBadgeType }>(Object.entries(storage_audit_kinds))

/** Display data for a kind; a kind this build does not know keeps its raw name. */
export function storage_audit_kind(kind: string) {
  return kinds.get(kind) ?? { name: kind, type: 'info' as const }
}

function readable_size(bytes: number) {
  return format_bytes(bytes, { decimals: bytes < 1024 ? 0 : 1 })
}

export function finding_sizes(finding: Pick<StorageAuditFinding, 'expected_size' | 'observed_size'>) {
  return [
    finding.expected_size === null ? '' : `应有 ${readable_size(finding.expected_size)}`,
    finding.observed_size === null ? '' : `实际 ${readable_size(finding.observed_size)}`,
  ].filter(Boolean).join('，')
}

/** Open storage audit findings are loaded on demand. */
export function useAdminStorageFindings(kind?: string) {
  const { admin } = useApi()
  const { error: toast_error } = useMyToast()
  const params = ref<Required<StorageAuditFindingsQuery>>({ page: 1, page_size: storage_audit_page_sizes[0]!, kinds: kind ? [kind] : [] })
  const result = ref<StorageAuditFindingsPage | null>(null)
  const findings = computed(() => result.value?.rows ?? null)
  const total = ref(0)
  const known_kinds = ref<string[]>([])
  const page = computed(() => result.value?.page ?? params.value.page)
  const page_size = computed(() => params.value.page_size)
  const selected_kinds = computed(() => params.value.kinds)
  const first_record_index = computed(() => (page.value - 1) * page_size.value)
  const loading = ref(false)
  const updated_at = ref<Date | null>(null)
  const stale = ref(false)
  const forbidden = ref(false)
  const refresh_version = ref(0)
  let refresh_query: (() => Promise<void>) | undefined
  const ready = useSyncedData(null, () => {
    // When findings close between requests, the server can move the reader to the last valid page.
    return admin.get_storage_audit_findings({
      page: page.value,
      page_size: page_size.value,
      kinds: selected_kinds.value.length ? selected_kinds.value : undefined,
    })
  }, result, loading, {
    server: false,
    share: false,
    fetch_without_resource: true,
    refresh_policy: 'latest',
    retry_on_error: false,
    query_key: computed(() => `admin-storage-findings:${JSON.stringify(params.value)}:${refresh_version.value}`),
    on_data: (value) => {
      if (value) {
        total.value = value.total
        known_kinds.value = [... new Set([... known_kinds.value, ... value.rows.map(row => row.kind)])]
        updated_at.value = new Date()
        stale.value = false
        forbidden.value = false
      }
    },
    on_error: (error) => {
      stale.value = true
      if (get_error_status(error) === 403) {
        forbidden.value = true
        result.value = null
        total.value = 0
        known_kinds.value = []
        updated_at.value = null
        toast_error('法无授权不可为，无权查看异常明细！')
        return
      }
      toast_error('读取异常明细失败，请『刷新』重试')
    },
  }).then((synced) => {
    refresh_query = synced.refresh
  })

  function refresh() {
    if (refresh_query)
      return refresh_query()
    // A filter can finish loading before the first request returns the refresh handle.
    refresh_version.value += 1
  }

  function load_query(query: Required<StorageAuditFindingsQuery>) {
    const same_query = JSON.stringify(query) === JSON.stringify(params.value)
    result.value = null
    updated_at.value = null
    stale.value = false
    if (same_query)
      return refresh()
    params.value = query
  }

  function change_page(event: { first: number, rows: number }) {
    const next_page = event.rows === page_size.value ? Math.floor(event.first / event.rows) + 1 : 1
    if (next_page !== page.value || event.rows !== page_size.value)
      load_query({ ... params.value, page: next_page, page_size: event.rows })
  }

  function select_kinds(kinds: string[]) {
    const next = [... kinds].sort()
    const same_kinds = JSON.stringify(next) === JSON.stringify(selected_kinds.value)
    if (same_kinds && page.value === 1)
      return refresh()
    if (! same_kinds)
      total.value = 0
    load_query({ ... params.value, page: 1, kinds: next })
  }

  function toggle_kind(kind: string) {
    select_kinds(selected_kinds.value.includes(kind)
      ? selected_kinds.value.filter(value => value !== kind)
      : [... selected_kinds.value, kind])
  }

  return { findings, loading, updated_at, stale, forbidden, total, known_kinds, selected_kinds, page_size, first_record_index, change_page, select_kinds, toggle_kind, refresh, ready }
}
