import type { AdminBackgroundStatus } from '~/features/admin/status'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import Card from 'primevue/card'
import { afterEach, expect, it } from 'vitest'
import MyHeightTransition from '../MyHeightTransition.vue'
import RunIssues from './RunIssues.vue'

const wrappers: { unmount: () => void }[] = []
afterEach(() => {
  wrappers.splice(0).forEach(wrapper => wrapper.unmount())
})

function status(): AdminBackgroundStatus {
  return { mode: 'worker', process: null, blocked: {}, observations: [],
    database: { ledgers: [], storage_audit: [], preload_targets: [], storage_audit_findings: [{ kind: 'missing_object', total: 4 }] },
    resources: { uptime_seconds: 5, rss_bytes: 0, heap_used_bytes: 0, external_bytes: 0, cpu_system_ms: 0, cpu_user_ms: 0 } }
}
async function mount_view(value: AdminBackgroundStatus | null) {
  const wrapper = await mountSuspended(RunIssues, {
    attachTo: document.body,
    props: { status: value, stale: false, canReadFindings: false },
    global: { stubs: { MyIcon: true } },
  })
  wrappers.push(wrapper)
  return wrapper
}

it('offers only object details from the summary when the viewer can read them', async () => {
  const wrapper = await mount_view(status())
  const sections = wrapper.findAll('section')
  expect(sections).toHaveLength(2)
  for (const section of sections)
    expect(section.attributes('aria-labelledby')).toBe(section.get('h2').attributes('id'))
  const cards = wrapper.findAllComponents(Card)
  expect(cards).toHaveLength(3)
  expect(cards.map(card => card.get('dt [aria-hidden="true"]').attributes('name'))).toEqual(['lucide:circle-pause', 'lucide:zap', 'lucide:database'])
  for (const card of cards)
    expect(card.getComponent(MyHeightTransition).find('dd').exists()).toBe(true)
  expect(wrapper.find('details').exists()).toBe(false)
  const issue = sections[1]!.get('li')
  expect(issue.get('h3').text()).toBe('找不到引用的文件')
  expect(issue.get('p').text()).toBe('各存储桶共 4 项未关闭')
  expect(issue.findAll('button')).toHaveLength(0)
  await wrapper.setProps({ canReadFindings: true })
  expect(issue.findAll('button')).toHaveLength(1)
  await issue.get('button[aria-label="查看明细：找不到引用的文件"]').trigger('click')
  expect(wrapper.emitted('show-storage')).toEqual([['missing_object']])
})

it('distinguishes missing or stale observations from measured counts', async () => {
  const value = status()
  const wrapper = await mount_view(null)
  const counts = () => wrapper.findAll('dd strong').map(number => number.text())
  expect(counts()).toEqual(['—', '—', '—'])
  value.database.storage_audit_findings[0]!.total = 1234567890
  await wrapper.setProps({ status: value })
  expect(counts()).toEqual(['0', '—', '1234567890'])
  expect(wrapper.text()).toMatch(/没有本机运行记录，\s*还没有存储审计记录$/)
  await wrapper.setProps({ status: { ... value, database: { ... value.database, storage_audit_findings: [] } } })
  expect(counts()).toEqual(['0', '—', '—'])
  await wrapper.setProps({ stale: true, status: value })
  expect(counts()).toEqual(['—', '—', '—'])
  expect(wrapper.find('li').exists()).toBe(false)
  expect(wrapper.find('[role="status"]').exists()).toBe(false)
})

it('counts one blocked task with runner and ledger errors once in each affected metric', async () => {
  const value = status()
  value.database.storage_audit_findings = []
  value.database.ledgers = [{
    id: 'retirement', interval_seconds: 30,
    groups: [{ phase: 'queued', pending: 2, total: 2, due: 2, leased: 0, oldest_pending_at: null, error_code: 'origin_delete_failed' }],
  }]
  value.blocked.retirement = 'unconfigured'
  value.process = { closed: false, resources: {}, adapters: [{ id: 'retirement', phase: 'idle', failures: 2, runs: 3,
    last_started_at: null, last_finished_at: null, last_duration_ms: null, last_error_code: 'sweep_failed' }] }
  const wrapper = await mount_view(value)
  expect(wrapper.findAll('li')).toHaveLength(1)
  expect(wrapper.findAll('dd strong').map(number => number.text())).toEqual(['1', '1', '—'])
  expect(wrapper.get('li').text()).not.toContain('sweep_failed')
})
