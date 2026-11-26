import type { AdminBackgroundStatus, AdminStageObservation } from '~/features/admin/status'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { afterEach, expect, it, vi } from 'vitest'
import { useDisplayTimeContext } from '#imports'
import { admin_tasks } from '~/features/admin/status'
import RunDetailCard from './RunDetailCard.vue'
import RunDetails from './RunDetails.vue'

const now = Date.parse('2026-11-12T12:00:00Z')
const ago = (ms: number) => new Date(now - ms).toISOString()
const wrappers: { unmount: () => void }[] = []
afterEach(() => {
  wrappers.splice(0).forEach(wrapper => wrapper.unmount())
  document.body.innerHTML = ''
})

function status(): AdminBackgroundStatus {
  return {
    mode: 'app',
    process: null,
    blocked: {},
    database: {
      ledgers: admin_tasks.map(task => ({ id: task.id, interval_seconds: 5, groups: [] })),
      preload_targets: [], storage_audit: [], storage_audit_findings: [],
    },
    observations: [],
    resources: { uptime_seconds: 266400, rss_bytes: 432 * 1024 ** 2, heap_used_bytes: 180 * 1024 ** 2, external_bytes: 0, cpu_user_ms: 9000, cpu_system_ms: 3300 },
  }
}
function target(values: Partial<AdminBackgroundStatus['database']['storage_audit'][number]> = {}) {
  return {
    destination_id: 'd06ce451'.padEnd(64, 'a'), phase: 'objects', references_checked: 1532, objects_checked: 4871,
    cycle_started_at: ago(5 * 3600_000), last_completed_at: null, next_run_at: ago(- 25_000), error_code: null, ... values,
  }
}
async function mount_details(value = status()) {
  useDisplayTimeContext().value = { now_ms: now, timezone: 'UTC' }
  const wrapper = await mountSuspended(RunDetails, {
    attachTo: document.body, props: { status: value }, global: { stubs: { MyIcon: true } },
  })
  wrappers.push(wrapper)
  return wrapper
}
function cards(wrapper: Awaited<ReturnType<typeof mount_details>>) {
  return wrapper.findAllComponents(RunDetailCard)
}

it('shows all four sections without interaction, withholds stale figures, and focuses the storage heading', async () => {
  const wrapper = await mount_details()
  expect(wrapper.findAll('h2').map(heading => heading.text())).toEqual(['仪表盘'])
  expect(cards(wrapper).map(card => card.get('h3').text())).toEqual(['后台任务', '存储审计', '当前进程', '处理用时'])
  expect(cards(wrapper).map(card => card.props('icon'))).toEqual(['lucide:list-checks', 'lucide:hard-drive', 'lucide:cpu', 'lucide:timer'])
  expect(wrapper.find('details, summary').exists()).toBe(false)
  const [tasks, storage, process, timing] = cards(wrapper)
  expect(tasks!.get('table').isVisible()).toBe(true)
  expect(process!.get('dl').isVisible()).toBe(true)
  expect(timing!.text()).toContain('尚未记录')
  const heading = storage!.get('h3').element
  const scroll = vi.spyOn(heading, 'scrollIntoView')
  wrapper.vm.showStorage()
  expect(document.activeElement).toBe(heading)
  expect(scroll).toHaveBeenCalledOnce()
  await wrapper.setProps({ status: status(), stale: true })
  for (const card of cards(wrapper)) {
    expect(card.props('subtitle')).toBe('状态更新中断')
    expect(card.find('table, dl, [role="progressbar"]').exists()).toBe(false)
  }
  await wrapper.setProps({ stale: false })
  expect(tasks!.get('table').isVisible()).toBe(true)
})

it('shows one status and a count for each task, distinguishing missing data from zero', async () => {
  const value = status()
  value.mode = 'worker'
  value.blocked = { retirement: 'unconfigured', preload: null }
  value.database.ledgers[0]!.groups.push(
    { phase: 'queued', error_code: null, total: 1, pending: 1, due: 1, leased: 0, oldest_pending_at: ago(200_000) },
    { phase: 'processing', error_code: null, total: 2, pending: 2, due: 0, leased: 2, oldest_pending_at: ago(20_000) },
    { phase: 'failed', error_code: 'decode_failed', total: 4, pending: 0, due: 0, leased: 0, oldest_pending_at: null },
  )
  value.database.ledgers.push({ id: 'future_task', interval_seconds: null, groups: [] })
  value.database.ledgers[3]!.groups.push({ phase: 'queued', error_code: 'quota_exhausted', total: 1, pending: 1, due: 0, leased: 0, oldest_pending_at: null })
  value.database.ledgers[4]!.groups.push({ phase: 'pending', error_code: 'delivery_unconfirmed', total: 1, pending: 1, due: 0, leased: 0, oldest_pending_at: null })
  value.database.ledgers = value.database.ledgers.filter(ledger => ledger.id !== 'receipts')
  const wrapper = await mount_details(value)
  const [tasks, , process] = cards(wrapper)
  const rows = tasks!.findAll('tbody tr')
  const values = rows.map(row => row.findAll('td').map(cell => cell.text()))
  expect(tasks!.findAll('th').map(cell => cell.text())).toEqual(['任务', '待办', '运行情况'])
  expect(values).toEqual([
    ['同步通知', '1', '待办出错'], ['图片处理', '3', '执行状态未知'], ['边缘预热', '1', '执行状态未知'],
    ['上传收尾', '0', '执行状态未知'], ['存储对象清理', '0', '配置不完整'], ['回执压缩', '—', '执行状态未知'],
    ['存储审计', '0', '执行状态未知'], ['future_task', '0', '执行状态未知'],
  ])
  expect(tasks!.props('subtitle')).toMatch(/图片处理有 3 项待办.*前/)
  expect(process!.text()).toContain('独立进程')
  expect(process!.find('[role="progressbar"]').exists()).toBe(false)
  value.database.ledgers.find(ledger => ledger.id === 'retirement')!.groups.push({
    phase: 'deleting', error_code: null, total: 4, pending: 4, due: 4, leased: 0, oldest_pending_at: ago(32 * 60_000),
  })
  await wrapper.setProps({ status: { ... value } })
  expect(tasks!.get('tbody tr').findAll('td').map(cell => cell.text())).toEqual(['存储对象清理', '4', '配置不完整'])
  expect(tasks!.props('subtitle')).toMatch(/存储对象清理有 4 项待办，最早待办\s+32 分钟前/)
  await wrapper.setProps({ status: { ... value, mode: 'disabled' } })
  expect(tasks!.get('tbody tr').findAll('td').map(cell => cell.text())).toEqual(['图片处理', '3', '已停用'])
})

it('distinguishes an unstarted or first audit from zero findings and keeps totals across buckets', async () => {
  const value = status()
  const wrapper = await mount_details(value)
  const storage = cards(wrapper)[1]!
  expect(storage.text()).toContain('尚无存储桶检查记录')
  expect(storage.text()).not.toContain('0 项')
  const running = target({ error_code: 'access_denied' })
  await wrapper.setProps({ status: { ... value, database: { ... value.database, storage_audit: [running] } } })
  expect(storage.text()).toContain('首次检查')
  expect(storage.text()).toContain('待首次检查完成')
  expect(storage.find('h4').exists()).toBe(false)
  expect(storage.findAll('.audit-counts dd').map(number => number.text())).toEqual(['1,532', '4,871'])
  expect(storage.findAll('.run-facts dd').map(field => field.text())).toEqual(['核对存储对象时出错', '5 小时前', '尚未完成', '待首次检查完成'])
  expect(storage.get('time').attributes('datetime')).toBe(running.cycle_started_at)
  expect(storage.text()).not.toContain('access_denied')
  // A zero or sub-second difference reads as "刚刚" instead of flipping between 前/后 on clock noise.
  await wrapper.setProps({ status: { ... value, database: { ... value.database, storage_audit: [target({ cycle_started_at: ago(0) })] } } })
  expect(storage.get('time').text()).toBe('刚刚')
  await wrapper.setProps({ status: { ... value, database: { ... value.database, storage_audit: [target({ cycle_started_at: ago(- 400) })] } } })
  expect(storage.get('time').text()).toBe('刚刚')
  const completed = target({ destination_id: 'b'.repeat(64), phase: 'completed', cycle_started_at: ago(26 * 3600_000), last_completed_at: ago(4 * 3600_000) })
  const findings = [{ kind: 'missing_object', total: 2 }, { kind: 'future_kind', total: 1 }, { kind: 'size_mismatch', total: 0 }]
  await wrapper.setProps({ status: { ... value, database: { ... value.database, storage_audit: [running, completed], storage_audit_findings: findings } } })
  expect(storage.findAll('h4').map(heading => heading.text())).toEqual(['存储桶 d06ce451', '存储桶 bbbbbbbb'])
  expect(storage.props('subtitle')).toContain('，3 项异常未关闭')
  expect(storage.findAll('time').map(time => time.text())).toEqual(['5 小时前', '1 天 2 小时前', '4 小时前'])
  expect(storage.findAll('.run-facts dd').at(- 1)!.text()).toBe('2 项对象缺失、1 项future_kind')
  expect(storage.text()).not.toContain('大小不符')
  await wrapper.setProps({ status: { ... value, database: { ... value.database, storage_audit: [completed] } } })
  expect(storage.props('subtitle')).toMatch(/4 小时前\s*完成检查.*0 项/)
})

it.each([
  { phase: 'attachments', failed: true, label: '核对附件引用时出错' },
  { phase: 'avatars', failed: true, label: '核对头像引用时出错' },
  { phase: 'static', failed: true, label: '核对静态文件时出错' },
  { phase: 'objects', failed: true, label: '核对存储对象时出错' },
  { phase: 'findings', failed: true, label: '复核异常时出错' },
  { phase: 'completed', failed: true, label: '存储检查出错' },
  { phase: 'future_phase', failed: true, label: '存储检查出错' },
  { phase: 'future_phase', failed: false, label: 'future_phase' },
])('describes the audit phase without inventing an action: $phase, failed=$failed', async ({ phase, failed, label }) => {
  const value = status()
  value.database.storage_audit = [target({ phase, error_code: failed ? 'simulated_failure' : null })]
  const wrapper = await mount_details(value)
  const storage = cards(wrapper)[1]!
  expect(storage.findAll('.run-facts dd')[0]!.text()).toBe(label)
  expect(storage.text()).not.toContain('simulated_failure')
})

it('uses local execution and capacity figures and keeps zero percentiles distinct from missing samples', async () => {
  const value = status()
  value.process = {
    closed: true, resources: { oss: { capacity: 2, used: 2 }, esa: { capacity: 4, used: 1 }, image: { capacity: 2, used: 0 }, notification: { capacity: 1, used: 0 } },
    adapters: [{ id: 'images', phase: 'running', runs: 1204, failures: 3, last_error_code: 'sweep_failed', last_duration_ms: 340, last_started_at: ago(12_000), last_finished_at: null }],
  }
  const image: AdminStageObservation = { stage: 'image_job', count: 256, failed: 2, active: 1, peak_active: 3, total_ms: 2000, max_ms: 210,
    recent_count: 128, recent_p50_ms: 0, recent_p95_ms: 40 }
  value.observations = [image, { ... image, stage: 'toString' as AdminStageObservation['stage'], count: 0, active: 1, recent_count: 0, recent_p50_ms: null, recent_p95_ms: null }]
  const wrapper = await mount_details(value)
  const [tasks, , process, timing] = cards(wrapper)
  expect(tasks!.get('tbody tr').findAll('td').map(cell => cell.text())).toEqual(['图片处理', '0', '本轮运行中'])
  expect(process!.props('subtitle')).toBe('已运行 3 天 2 小时，常驻内存 432 MB')
  expect(process!.findAll('dt').map(field => field.text())).toEqual(['已运行', '常驻内存', '累计 CPU 时间'])
  expect(process!.findAll('dd').map(field => field.text())).toEqual(['3 天 2 小时', '432 MB', '12 秒'])
  expect(process!.text()).toContain('执行器正在关闭')
  const quota_heading = process!.find('section [id]')
  expect(quota_heading.text()).toBe('后台并发名额')
  expect(process!.find('section').attributes('aria-labelledby')).toBe(quota_heading.attributes('id'))
  expect(process!.findAll('[role="progressbar"]').map(bar => [bar.attributes('aria-label'), bar.attributes('aria-valuenow'), bar.attributes('aria-valuetext')])).toEqual([
    ['对象存储并发占用', '100', '已用 2，容量 2'], ['边缘服务并发占用', '25', '已用 1，容量 4'],
    ['图片处理并发占用', '0', '已用 0，容量 2'], ['同步通知并发占用', '0', '已用 0，容量 1'],
  ])
  expect(timing!.props('subtitle')).toMatch(/128 次图片处理.*中位耗时 0 毫秒/)
  expect(timing!.findAll('th').map(cell => cell.text())).toEqual(['环节', '中位耗时', 'P95 耗时'])
  const samples = timing!.findAll('tbody tr')
  expect(samples).toHaveLength(2)
  expect(samples[0]!.findAll('td').map(cell => cell.text())).toEqual(['图片处理最近 128 次', '0 毫秒', '40 毫秒'])
  expect(samples[1]!.findAll('td').map(cell => cell.text())).toEqual(['toString正在计时', '—', '—'])
  const idle = { ... value.process.adapters[0]!, phase: 'idle' as const }
  await wrapper.setProps({ status: { ... value, process: { ... value.process, adapters: [idle] } } })
  expect(tasks!.get('tbody tr').findAll('td').at(- 1)!.text()).toBe('上次扫描出错')
  await wrapper.setProps({ status: { ... value, process: { ... value.process, adapters: [{ ... idle, last_error_code: null }] } } })
  expect(tasks!.get('tbody tr').findAll('td').at(- 1)!.text()).toBe('空闲')
})

it('shows every measured or active timing stage immediately and updates the readings on refresh', async () => {
  const value = status()
  function reading(stage: AdminStageObservation['stage'], options: Partial<AdminStageObservation> = {}): AdminStageObservation {
    return { stage, active: 0, peak_active: 1, count: 2, failed: 0, total_ms: 24, max_ms: 12, recent_count: 2, recent_p50_ms: 12, recent_p95_ms: 12, ... options }
  }
  const unseen = reading('upload_seal', { count: 0, active: 0, peak_active: 0, total_ms: 0, max_ms: 0, recent_count: 0, recent_p50_ms: null, recent_p95_ms: null })
  value.observations = [
    reading('image_source_info'), reading('image_claim'), reading('db_acquire'), reading('multipart_complete'),
    reading('image_lqip', { failed: 1 }), reading('upload_adopt', { active: 1 }), reading('image_job'), unseen,
  ]
  const wrapper = await mount_details(value)
  const timing = cards(wrapper)[3]!
  const shown = () => timing.findAll('tbody tr').map(row => row.get('td span').text())
  expect(shown()).toEqual(['图片处理', '接收上传文件', '生成占位图', '分片上传合并', '数据库取连接', '读取原图信息', '领取图片任务'])
  expect(timing.find('button').exists()).toBe(false)

  await wrapper.setProps({ status: { ... value, observations: [unseen] } })
  expect(timing.text()).toContain('尚未记录')
  expect(timing.find('table').exists()).toBe(false)
  expect(timing.find('button').exists()).toBe(false)
  const active = { ... unseen, active: 1, peak_active: 1 }
  await wrapper.setProps({ status: { ... value, observations: [active] } })
  expect(timing.props('subtitle')).toContain('1 个环节正在处理')
  expect(timing.get('tbody tr').findAll('td').map(cell => cell.text())).toEqual(['封存上传正在计时', '—', '—'])
  expect(timing.find('button').exists()).toBe(false)

  const next = { ... value, observations: value.observations.filter(item => ! item.active && ! item.failed) }
  await wrapper.setProps({ status: next, stale: true })
  expect(timing.find('table').exists()).toBe(false)
  await wrapper.setProps({ stale: false })
  expect(shown()).toEqual(['图片处理', '分片上传合并', '数据库取连接', '读取原图信息', '领取图片任务'])
  expect(timing.find('button').exists()).toBe(false)
})
