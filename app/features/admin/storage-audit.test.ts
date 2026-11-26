import type { StorageAuditFinding, StorageAuditFindingsPage } from '@shared/types/storage-audit'
import type { Ref } from 'vue'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { computed, ref } from 'vue'
import { finding_sizes, storage_audit_kind, useAdminStorageFindings } from './storage-audit'

let get_findings: ReturnType<typeof vi.fn>
let synced: {
  fetcher: () => unknown
  data: Ref<StorageAuditFindingsPage | null>
  options: { query_key: { value: string }, polling_interval?: number, retry_on_error?: boolean, server: boolean, on_data: (value: StorageAuditFindingsPage) => void }
}
let refresh: ReturnType<typeof vi.fn>

function show_page(page: number, total: number) {
  const value = { page, total, rows: [{ id: page, kind: 'missing_object' } as StorageAuditFinding] }
  synced.data.value = value
  synced.options.on_data(value)
}

beforeEach(() => {
  get_findings = vi.fn(async () => ({ rows: [], page: 1, total: 0 }))
  refresh = vi.fn(async () => {})
  vi.stubGlobal('ref', ref)
  vi.stubGlobal('computed', computed)
  vi.stubGlobal('useApi', () => ({ admin: { get_storage_audit_findings: get_findings } }))
  vi.stubGlobal('useMyToast', () => ({ error: vi.fn() }))
  vi.stubGlobal('useSyncedData', vi.fn(async (_resource: unknown, fetcher: typeof synced.fetcher, data: typeof synced.data, _loading: unknown, options: typeof synced.options) => {
    synced = { fetcher, data, options }
    return { refresh }
  }))
})
afterEach(() => vi.unstubAllGlobals())

it('names the known kinds and keeps an unknown or inherited name as it is', () => {
  expect(storage_audit_kind('missing_object')).toMatchObject({ name: '对象缺失', type: 'error' })
  expect(storage_audit_kind('orphan_candidate')).toEqual({ name: '疑似无主对象', type: 'info' })
  expect(storage_audit_kind('brand_new_kind')).toEqual({ name: 'brand_new_kind', type: 'info' })
  expect(storage_audit_kind('toString')).toEqual({ name: 'toString', type: 'info' })
})

it('shows sizes in human-readable units and leaves out the side the audit did not record', () => {
  expect(finding_sizes({ expected_size: 1_258_291, observed_size: 1_258_290 })).toBe('应有 1.2 MB，实际 1.2 MB')
  expect(finding_sizes({ expected_size: null, observed_size: 17_587 })).toBe('实际 17.2 KB')
  expect(finding_sizes({ expected_size: 512, observed_size: null })).toBe('应有 512 B')
  expect(finding_sizes({ expected_size: null, observed_size: 0 })).toBe('实际 0 B')
  expect(finding_sizes({ expected_size: null, observed_size: null })).toBe('')
})

it('pages by number, combines selected types, and resets the page on filter and page size changes', async () => {
  const list = useAdminStorageFindings('missing_object')
  await list.ready
  expect(synced.options.server).toBe(false)
  expect(synced.options.polling_interval).toBeUndefined()
  expect(synced.options.retry_on_error).toBe(false)
  const first_key = synced.options.query_key.value
  synced.fetcher()
  expect(get_findings).toHaveBeenLastCalledWith({ page: 1, page_size: 10, kinds: ['missing_object'] })

  show_page(1, 37)
  list.change_page({ first: 30, rows: 10 })
  expect(list.first_record_index.value).toBe(30)
  expect(list.total.value).toBe(37)
  expect(list.findings.value).toBeNull()
  expect(synced.options.query_key.value).not.toBe(first_key)
  synced.fetcher()
  expect(get_findings).toHaveBeenLastCalledWith({ page: 4, page_size: 10, kinds: ['missing_object'] })

  list.toggle_kind('size_mismatch')
  expect(list.first_record_index.value).toBe(0)
  expect(list.total.value).toBe(0)
  expect(list.selected_kinds.value).toEqual(['missing_object', 'size_mismatch'])
  synced.fetcher()
  expect(get_findings).toHaveBeenLastCalledWith({ page: 1, page_size: 10, kinds: ['missing_object', 'size_mismatch'] })

  list.change_page({ first: 50, rows: 50 })
  expect(list.first_record_index.value).toBe(0)
  list.select_kinds([])
  synced.fetcher()
  expect(get_findings).toHaveBeenLastCalledWith({ page: 1, page_size: 50, kinds: undefined })
})

it('refreshes the last valid page if the selected page disappeared', async () => {
  const list = useAdminStorageFindings()
  await list.ready
  list.change_page({ first: 30, rows: 10 })
  show_page(2, 17)
  expect(list.first_record_index.value).toBe(10)
  await list.refresh()
  expect(refresh).toHaveBeenCalledTimes(1)
  synced.fetcher()
  expect(get_findings).toHaveBeenLastCalledWith({ page: 2, page_size: 10, kinds: undefined })
  show_page(2, 37)
  await list.change_page({ first: 30, rows: 10 })
  expect(refresh).toHaveBeenCalledTimes(2)
  synced.fetcher()
  expect(get_findings).toHaveBeenLastCalledWith({ page: 4, page_size: 10, kinds: undefined })
})
