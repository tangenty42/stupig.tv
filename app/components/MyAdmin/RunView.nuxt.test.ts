import type { PermissionGrant } from '@shared/permissions'
import type { StorageAuditFinding, StorageAuditFindingsPage, StorageAuditFindingsQuery } from '@shared/types/storage-audit'
import type { AdminBackgroundStatus } from '~/features/admin/status'
import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { afterEach, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { useDisplayTimeContext } from '#imports'
import { storage_audit_kinds } from '~/features/admin/storage-audit'
import RunView from './RunView.vue'
import StorageFindings from './StorageFindings.vue'

const boundary = vi.hoisted(() => ({ get_background_status: vi.fn(), get_storage_audit_findings: vi.fn(), toast_error: vi.fn() }))
const readonly_grant: PermissionGrant = { field: 'admin_access', level: 'readonly' }
const viewer = ref({ id: 7, is_admin: false, permissions: [readonly_grant] })
mockNuxtImport('useApi', () => () => ({ admin: boundary }))
mockNuxtImport('useAuth', () => () => ({ user: viewer }))
mockNuxtImport('useMyToast', () => () => ({ error: boundary.toast_error }))
mockNuxtImport('useDataSync', () => () => ({ subscribe: () => () => {} }))

const now = Date.parse('2026-11-12T12:00:00Z')
const ago = (ms: number) => new Date(now - ms).toISOString()
const wrappers: { unmount: () => void }[] = []
afterEach(() => {
  wrappers.splice(0).forEach(wrapper => wrapper.unmount())
  document.body.innerHTML = ''
  boundary.get_background_status.mockReset()
  boundary.get_storage_audit_findings.mockReset()
  boundary.toast_error.mockClear()
  viewer.value = { id: 7, is_admin: false, permissions: [readonly_grant] }
})

function finding(id: number, values: Partial<StorageAuditFinding> = {}): StorageAuditFinding {
  return { id, object_key: `content/attachments/${id}`, kind: 'missing_object', expected_size: 2048, observed_size: null, observations: 3, first_seen_at: ago(2 * 86_400_000), last_seen_at: ago(300_000), resolved_at: null, ... values }
}

function finding_page(findings: StorageAuditFinding[], { page, page_size, kinds }: StorageAuditFindingsQuery) {
  const matching = findings.filter(row => ! kinds?.length || kinds.includes(row.kind))
  const current_page = Math.min(page, Math.max(1, Math.ceil(matching.length / page_size)))
  const index = (current_page - 1) * page_size
  return { rows: matching.slice(index, index + page_size), total: matching.length, page: current_page }
}

async function mount_view(database: Partial<AdminBackgroundStatus['database']>, findings: StorageAuditFinding[] = []) {
  boundary.get_background_status.mockResolvedValue({ mode: 'app', blocked: {}, process: null, database: { ledgers: [], storage_audit: [], storage_audit_findings: [], preload_targets: [], ... database }, observations: [], resources: { uptime_seconds: 100, rss_bytes: 200, heap_used_bytes: 150, external_bytes: 0, cpu_user_ms: 50, cpu_system_ms: 10 } })
  boundary.get_storage_audit_findings.mockImplementation(async query => finding_page(findings, query))
  useDisplayTimeContext().value = { now_ms: now, timezone: 'UTC' }
  const wrapper = await mountSuspended(RunView, { props: { focusStorage: false }, attachTo: document.body, global: { stubs: { MyIcon: { props: ['name'], template: '<span :data-icon="name" />' } } } })
  wrappers.push(wrapper)
  await flushPromises()
  return wrapper
}

it('lets a read-only viewer open object details on demand and drops them when access is revoked', async () => {
  const wrapper = await mount_view({
    storage_audit: [{ destination_id: `3fa9c1e2${'0'.repeat(56)}`, phase: 'objects', references_checked: 1532, objects_checked: 4871, cycle_started_at: ago(5 * 3_600_000), last_completed_at: null, next_run_at: new Date(now + 25_000).toISOString(), error_code: 'access_denied' }],
    storage_audit_findings: [{ kind: 'orphan_candidate', total: 2 }, { kind: 'missing_object', total: 1 }, { kind: 'size_mismatch', total: 0 }],
  }, [finding(7)])
  const totals = wrapper.get('[aria-label="异常概况"]').findAll('dd')
  expect(totals[2]!.text()).toMatch(/3\s*项/)
  const issues = wrapper.findAll('section').find(section => section.find('h2').text() === 'TODO')!
  expect(issues.findAll('h3').map(heading => heading.text())).toContain('文件归属待确认')
  expect(wrapper.findAll('h2').map(heading => heading.text())).toContain('异常明细')
  expect(wrapper.findComponent(StorageFindings).exists()).toBe(false)
  expect(boundary.get_storage_audit_findings).not.toHaveBeenCalled()
  expect(boundary.get_background_status).toHaveBeenCalledTimes(1)
  const issue_button = 'button[aria-label="查看明细：找不到引用的文件"]'
  await issues.get(issue_button).trigger('click')
  await flushPromises()
  expect(boundary.get_storage_audit_findings).toHaveBeenCalledTimes(1)
  expect(wrapper.getComponent(StorageFindings).text()).toContain('content/attachments/7')

  viewer.value.permissions = []
  await flushPromises()
  expect(wrapper.findAll('h2').map(heading => heading.text())).not.toContain('异常明细')
  expect(issues.find(issue_button).exists()).toBe(false)
  expect(wrapper.text()).not.toContain('content/attachments/7')

  viewer.value.permissions = [readonly_grant]
  await flushPromises()
  expect(wrapper.get('button[aria-label="读取异常明细"]').isVisible()).toBe(true)
  expect(boundary.get_storage_audit_findings).toHaveBeenCalledTimes(1)
})

it('shows finding metadata, numbered pages, and a retry after a page fails to load', async () => {
  viewer.value = { id: 7, is_admin: true, permissions: [] }
  const findings = [finding(1, { kind: 'size_mismatch', expected_size: 1_258_291, observed_size: 1_258_290 }), ... Array.from({ length: 23 }, (_, index) => finding(index + 2))]
  const wrapper = await mount_view({
    storage_audit: [{ destination_id: 'a'.repeat(64), phase: 'completed', references_checked: 10, objects_checked: 20, cycle_started_at: ago(5 * 3_600_000), last_completed_at: ago(4 * 3_600_000), next_run_at: new Date(now + 19 * 3_600_000 + 60_000).toISOString(), error_code: null }],
  }, findings)
  expect(boundary.get_storage_audit_findings).not.toHaveBeenCalled()
  expect(wrapper.findAll('h2').map(heading => heading.text())).toContain('异常明细')
  expect(wrapper.findComponent(StorageFindings).exists()).toBe(false)
  await wrapper.get('button[aria-label="读取异常明细"]').trigger('click')
  await flushPromises()
  expect(boundary.get_storage_audit_findings).toHaveBeenLastCalledWith({ page: 1, page_size: 10, kinds: undefined })

  const details = wrapper.getComponent(StorageFindings)
  const rows = details.get('ul').findAll('li')
  expect(rows).toHaveLength(10)
  expect(rows.map(row => row.get('code').text())).toEqual(findings.slice(0, 10).map(row => row.object_key))
  expect(rows[0]!.text()).toContain(storage_audit_kinds.size_mismatch.name)
  expect(rows[0]!.get('.badge').classes()).toContain('badge-error-outlined')
  expect(rows[0]!.text()).toContain('应有 1.2 MB，实际 1.2 MB')
  expect(rows[1]!.text()).toContain(storage_audit_kinds.missing_object.name)
  expect(rows[1]!.text()).toContain('3 次')
  expect(rows[1]!.text()).toMatch(/首次\s*2 天前，最近\s*5 分钟前/)
  expect(rows[1]!.find('button').exists()).toBe(false)
  const paginator = details.get('[aria-label="异常明细分页"]')
  const page_button = (number: number) => paginator.findAll('button').find(button => button.text() === String(number))!
  expect(paginator.text()).toContain('1 ~ 10 / 24')
  expect(page_button(1).attributes('aria-current')).toBe('page')

  const results = details.get<HTMLElement>('[aria-busy]')
  vi.spyOn(results.element, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 400, 780))
  const next_page = Promise.withResolvers<StorageAuditFindingsPage>()
  boundary.get_storage_audit_findings.mockReturnValueOnce(next_page.promise)
  await page_button(3).trigger('click')
  expect(results.attributes('aria-busy')).toBe('true')
  expect(results.element.style.minHeight).toBe('780px')
  next_page.reject(new Error('Unavailable'))
  await flushPromises()
  expect(results.element.style.minHeight).toBe('')
  expect(boundary.get_storage_audit_findings).toHaveBeenLastCalledWith({ page: 3, page_size: 10, kinds: undefined })
  expect(details.find('li').exists()).toBe(false)
  expect(boundary.toast_error).toHaveBeenCalledExactlyOnceWith('读取异常明细失败，请『刷新』重试')
  expect(details.text()).not.toContain('读取异常明细失败')
  expect(page_button(3).attributes('aria-current')).toBe('page')
  await details.get('button[aria-label="刷新"]').trigger('click')
  await flushPromises()
  expect(paginator.text()).toContain('21 ~ 24 / 24')
  expect(details.get('ul').findAll('li')).toHaveLength(4)

  await page_button(1).trigger('click')
  await flushPromises()
  expect(boundary.get_storage_audit_findings).toHaveBeenLastCalledWith({ page: 1, page_size: 10, kinds: undefined })
  expect(wrapper.text()).toContain('content/attachments/1')

  boundary.get_storage_audit_findings.mockResolvedValue({ rows: [], total: 0, page: 1 })
  await details.get('button[aria-label="刷新"]').trigger('click')
  await flushPromises()
  expect(details.text()).toContain('当前存储桶没有未关闭的异常')
  expect(details.find('[aria-label="异常明细分页"]').exists()).toBe(false)
})

it('opens a TODO type at the first page, toggles multiple types, and clears the filter', async () => {
  const findings = [... Array.from({ length: 23 }, (_, i) => finding(i + 1)), finding(100, { kind: 'orphan_candidate' })]
  const wrapper = await mount_view({
    storage_audit_findings: [{ kind: 'missing_object', total: 23 }, { kind: 'size_mismatch', total: 1 }, { kind: 'orphan_candidate', total: 1 }],
  }, findings)
  const missing = wrapper.get('button[aria-label="查看明细：找不到引用的文件"]')
  const sizes = wrapper.get('button[aria-label="查看明细：文件大小与记录不符"]')
  const heading = wrapper.findAll('h2').find(heading => heading.text() === '异常明细')!
  await missing.trigger('click')
  await flushPromises()
  expect(boundary.get_storage_audit_findings).toHaveBeenLastCalledWith({ page: 1, page_size: 10, kinds: ['missing_object'] })
  const filters = wrapper.get('[aria-label="按异常类型筛选"]')
  const type_button = (name: string) => filters.findAll('button').find(button => button.text() === name)!
  expect(type_button('对象缺失').attributes('aria-pressed')).toBe('true')
  expect(type_button('对象缺失').get('span').classes()).toContain('badge-error')
  expect(type_button('大小不符').get('span').classes()).toContain('badge-error-outlined')
  expect(wrapper.get('[aria-label="对象异常记录"] li .badge').classes()).toContain('badge-error')
  const paginator = wrapper.get('[aria-label="异常明细分页"]')
  await paginator.findAll('button').find(button => button.text() === '2')!.trigger('click')
  await flushPromises()
  expect(boundary.get_storage_audit_findings).toHaveBeenLastCalledWith({ page: 2, page_size: 10, kinds: ['missing_object'] })

  await type_button('疑似无主对象').trigger('click')
  await flushPromises()
  expect(boundary.get_storage_audit_findings).toHaveBeenLastCalledWith({ page: 1, page_size: 10, kinds: ['missing_object', 'orphan_candidate'] })
  expect(type_button('疑似无主对象').attributes('aria-pressed')).toBe('true')
  expect(type_button('对象缺失').attributes('aria-pressed')).toBe('true')
  await missing.trigger('click')
  await flushPromises()
  expect(boundary.get_storage_audit_findings).toHaveBeenLastCalledWith({ page: 1, page_size: 10, kinds: ['missing_object'] })
  expect(type_button('疑似无主对象').attributes('aria-pressed')).toBe('false')
  const pending = Promise.withResolvers<StorageAuditFindingsPage>()
  boundary.get_storage_audit_findings.mockReturnValueOnce(pending.promise)
  ;(sizes.element as HTMLButtonElement).focus()
  await sizes.trigger('click')
  expect(document.activeElement).toBe(heading.element)
  expect(boundary.get_storage_audit_findings).toHaveBeenLastCalledWith({ page: 1, page_size: 10, kinds: ['size_mismatch'] })
  pending.resolve({ rows: [], total: 0, page: 1 })
  await flushPromises()
  expect(wrapper.getComponent(StorageFindings).text()).toContain('当前存储桶没有所选类型的未关闭异常')

  await type_button('清除').trigger('click')
  await flushPromises()
  expect(boundary.get_storage_audit_findings).toHaveBeenLastCalledWith({ page: 1, page_size: 10, kinds: undefined })
  expect(wrapper.get('[aria-label="异常明细分页"]').text()).toContain('1 ~ 10 / 24')
  expect(wrapper.get('[aria-label="对象异常记录"] li .badge').classes()).toContain('badge-error-outlined')
})

it('can refresh a filtered result while the superseded first request is still pending', async () => {
  const wrapper = await mount_view({ storage_audit_findings: [{ kind: 'missing_object', total: 1 }] }, [finding(7)])
  const initial = Promise.withResolvers<StorageAuditFindingsPage>()
  boundary.get_storage_audit_findings.mockReturnValueOnce(initial.promise)
  await wrapper.get('button[aria-label="读取异常明细"]').trigger('click')
  const details = wrapper.getComponent(StorageFindings)
  await details.get('[aria-label="按异常类型筛选"] button').trigger('click')
  await flushPromises()
  expect(details.text()).toContain('content/attachments/7')
  expect(boundary.get_storage_audit_findings).toHaveBeenCalledTimes(2)

  await details.get('button[aria-label="刷新"]').trigger('click')
  await flushPromises()
  expect(boundary.get_storage_audit_findings).toHaveBeenCalledTimes(3)
  expect(boundary.get_storage_audit_findings).toHaveBeenLastCalledWith({ page: 1, page_size: 10, kinds: ['missing_object'] })
  initial.resolve({ rows: [finding(8)], page: 1, total: 1 })
  await flushPromises()
  expect(details.text()).toContain('content/attachments/7')
  expect(details.text()).not.toContain('content/attachments/8')
})

it('retains a previous result during a network failure and clears it when permission is revoked', async () => {
  const wrapper = await mount_view({ storage_audit_findings: [{ kind: 'missing_object', total: 1 }] }, [finding(7)])
  expect(boundary.get_storage_audit_findings).not.toHaveBeenCalled()
  const findings_heading = wrapper.findAll('h2').find(heading => heading.text() === '异常明细')!
  await wrapper.get('button[aria-label="查看明细：找不到引用的文件"]').trigger('click')
  await flushPromises()
  expect(document.activeElement).toBe(findings_heading.element)
  expect(boundary.get_storage_audit_findings).toHaveBeenCalledTimes(1)
  await wrapper.get('button[aria-label="查看明细：找不到引用的文件"]').trigger('click')
  await flushPromises()
  expect(boundary.get_storage_audit_findings).toHaveBeenCalledTimes(2)
  const details = wrapper.getComponent(StorageFindings)
  const refresh = details.get('button[aria-label="刷新"]')
  boundary.get_storage_audit_findings.mockRejectedValueOnce(new Error('Unavailable'))
  await refresh.trigger('click')
  await flushPromises()
  expect(boundary.toast_error).toHaveBeenCalledExactlyOnceWith('读取异常明细失败，请『刷新』重试')
  expect(details.text()).not.toContain('读取异常明细失败')
  expect(details.text()).toContain('content/attachments/7')

  boundary.get_storage_audit_findings.mockRejectedValueOnce(Object.assign(new Error('Forbidden'), { data: { httpStatus: 403 } }))
  await refresh.trigger('click')
  await flushPromises()
  expect(boundary.toast_error.mock.calls).toEqual([
    ['读取异常明细失败，请『刷新』重试'],
    ['法无授权不可为，无权查看异常明细！'],
  ])
  expect(details.text()).not.toContain('法无授权不可为，无权查看异常明细！')
  expect(details.text()).not.toContain('content/attachments/7')
  expect(details.find('time').exists()).toBe(false)
  expect(details.text()).toContain('—')
})

it('keeps a first audit distinct from a completed audit with zero findings', async () => {
  const wrapper = await mount_view({})
  const totals = wrapper.get('[aria-label="异常概况"]').findAll('dd')
  expect(totals[2]!.text()).toContain('—')
  expect(boundary.get_storage_audit_findings).not.toHaveBeenCalled()
})
