import type { Locator, Page } from '@playwright/test'
import type { get_background_status } from '@server/services/background/status.service'
import type { AdminUserList } from '@shared/types/user'
import { expect } from '@playwright/test'
import { settings } from '@shared/settings'
import { login, ready, set_page_visibility, test } from '../support/e2e-browser'

async function expect_run_layout(page: Page, columns: 1 | 2) {
  const main = page.getByRole('main')
  await expect(main.getByRole('heading', { level: 2 })).toHaveText(['异常概况', 'TODO', '仪表盘', '异常明细'])
  const metrics = main.getByRole('region', { name: '异常概况', exact: true }).locator('.p-card')
  await expect(metrics).toHaveCount(3)
  for (const metric of await metrics.all())
    await expect(metric.locator('.my-height-transition')).toHaveCount(1)
  const metric_boxes = await metrics.evaluateAll(cards => cards.map(card => card.getBoundingClientRect().toJSON()))
  for (const [index, box] of metric_boxes.entries()) {
    expect(Math.abs(box.top - metric_boxes[0].top)).toBeLessThan(2)
    expect(box.left).toBeGreaterThanOrEqual(index ? metric_boxes[index - 1].right : 0)
    expect(box.right).toBeLessThanOrEqual(page.viewportSize()!.width + 1)
  }
  const details = main.getByRole('region', { name: '仪表盘', exact: true })
  const cards = details.locator('.p-card').filter({ has: page.getByRole('heading', { level: 3 }) })
  await expect(cards).toHaveCount(4)
  const titles = ['后台任务', '存储审计', '当前进程', '处理用时']
  if (columns === 1)
    await expect(details.getByRole('heading', { level: 3 })).toHaveText(titles)
  for (const card of await cards.all())
    await expect(card.locator('.my-height-transition')).toHaveCount(1)
  await expect(async () => {
    const boxes = await cards.evaluateAll((items, names) => names.map(name =>
      items.find(item => item.querySelector('h3')?.textContent?.trim() === name)!.getBoundingClientRect().toJSON()), titles)
    const placed: { left: number, bottom: number }[] = []
    for (const [index, box] of boxes.entries()) {
      expect(box.left).toBeGreaterThanOrEqual(0)
      expect(box.right).toBeLessThanOrEqual(page.viewportSize()!.width + 1)
      if (index < columns) {
        expect(Math.abs(box.top - boxes[0].top)).toBeLessThan(2)
        if (index)
          expect(box.left).toBeGreaterThanOrEqual(boxes[index - 1].right)
        placed.push({ left: box.left, bottom: box.bottom })
        continue
      }
      const column = placed.find(column => Math.abs(column.left - box.left) < 2)
      expect(column).toBeDefined()
      const shortest = Math.min(... placed.map(column => column.bottom))
      expect(Math.abs(column!.bottom - shortest)).toBeLessThan(2)
      const gap = box.top - column!.bottom
      expect(gap).toBeGreaterThanOrEqual(0)
      expect(gap).toBeLessThanOrEqual(24)
      column!.bottom = box.bottom
    }
  }).toPass({ timeout: 5000 })
  await expect(main.locator('details, summary')).toHaveCount(0)
}

function observe_height(container: Locator) {
  return container.evaluateHandle((el) => {
    const events: string[] = []
    for (const type of ['transitionrun', 'transitionend']) {
      el.addEventListener(type, (event) => {
        if (event.target === el && (event as TransitionEvent).propertyName === 'height')
          events.push(type)
      })
    }
    return events
  })
}

async function expect_compact_table(table: Locator, headings: string[]) {
  await expect(table.getByRole('columnheader')).toHaveText(headings)
  const layout = await table.evaluate((el) => {
    const container = el.parentElement!
    const headers = [... el.querySelectorAll('thead th')].map(cell => cell.getBoundingClientRect())
    const rows = [... el.querySelectorAll('tbody tr')].map(row => [... row.querySelectorAll('td')].map(cell => cell.getBoundingClientRect()))
    return {
      fits: container.scrollWidth <= container.clientWidth + 1 && headers[0]!.left >= 0 && headers.at(- 1)!.right <= window.innerWidth + 1,
      header_visible: el.querySelector('thead')!.getBoundingClientRect().height > 1,
      aligned: rows.length > 0 && rows.every(cells => cells.length === headers.length && cells.every((cell, index) =>
        Math.abs(cell.left - headers[index]!.left) < 1 && Math.abs(cell.top - cells[0]!.top) < 1)),
    }
  })
  expect(layout).toEqual({ fits: true, header_visible: true, aligned: true })
}

test('the console combines runtime status, keeps legacy links and loads storage details on demand for console readers', async ({ page, browser }) => {
  const mismatches: string[] = []
  page.on('console', (message) => {
    if (/hydration.*mismatch/i.test(message.text()))
      mismatches.push(message.text())
  })
  await login(page)
  const main = page.getByRole('main')
  const views = page.locator('[aria-label="控制台视图"]')
  const title_positions = new Map<number, { x: number, y: number }>()
  async function expect_view_header(title: string, seconds: number) {
    const heading = main.getByRole('heading', { level: 1 })
    await expect(heading).toHaveText(title)
    const position = await heading.evaluate((el) => {
      const text = document.createRange()
      text.selectNodeContents(el.lastChild!)
      const bounds = text.getBoundingClientRect()
      return { x: bounds.left + window.scrollX, y: bounds.top + window.scrollY }
    })
    const width = page.viewportSize()!.width
    const previous = title_positions.get(width)
    if (previous) {
      expect(position.x).toBeCloseTo(previous.x, 0)
      expect(position.y).toBeCloseTo(previous.y, 0)
    }
    else {
      title_positions.set(width, position)
    }
    const header = main.locator('header').filter({ has: page.getByRole('heading', { level: 1 }) })
    if (title === '运行状态') {
      const frame = await header.evaluate((el) => {
        const style = getComputedStyle(el.parentElement!)
        return { background: style.backgroundColor, border: style.borderWidth, padding: style.padding, margin: style.margin }
      })
      expect(frame).toEqual({ background: 'rgba(0, 0, 0, 0)', border: '0px', padding: '0px', margin: '0px' })
    }
    const poll_label = header.getByText(`每 ${seconds} 秒自动更新`, { exact: true })
    await expect(poll_label).toBeVisible()
    const time = header.locator('time')
    await expect(time).toHaveAttribute('datetime', /^\d{4}-\d{2}-\d{2}T/)
    await expect(time).toHaveText(/(刚刚|\S+前)\s*更新$/)
    const poll = await poll_label.boundingBox()
    const latest = await time.boundingBox()
    expect(latest!.x).toBeGreaterThan(poll!.x + poll!.width)
    expect(Math.abs(latest!.y - poll!.y)).toBeLessThan(4)
    return time
  }
  let admin_detail_requests = 0
  page.on('request', (request) => {
    if (request.url().includes('getStorageAuditFindings'))
      admin_detail_requests ++
  })
  await test.step('the old task link opens runtime status and survives a reload', async () => {
    await page.context().addCookies([{ name: settings.app.client.colorMode.cookieName, value: 'light', url: new URL(page.url()).origin }])
    await page.goto('/admin?view=tasks')
    await ready(page)
    await expect(views.getByRole('button')).toHaveCount(2)
    await expect_view_header('运行状态', settings.app.admin.statusPollIntervalSeconds)
    await expect_run_layout(page, 2)
    await expect(page.getByRole('cell', { name: '存储对象清理', exact: true })).toBeVisible()
    const task_table = main.getByRole('region', { name: '后台任务', exact: true }).getByRole('table')
    await expect_compact_table(task_table, ['任务', '待办', '运行情况'])
    await expect(page.locator('.p-autocomplete-input')).toHaveCount(0)
    // Capture the console content without the signed-in account menu or any object-level findings.
    await page.getByRole('main').locator(':scope > div').screenshot({
      path: test.info().outputPath('runtime-desktop-light.png'), style: 'header.fixed { display: none !important; transition: none !important }',
    })
    await page.reload()
    await ready(page)
    await expect(page.getByRole('heading', { name: '当前进程', level: 3, exact: true })).toBeVisible()
    expect(mismatches).toEqual([])
    expect(admin_detail_requests).toBe(0)
  })

  await test.step('the old audit link focuses the heading at 320px in dark mode without requesting findings', async () => {
    await page.setViewportSize({ width: 320, height: 812 })
    await page.context().addCookies([{ name: settings.app.client.colorMode.cookieName, value: 'dark', url: new URL(page.url()).origin }])
    await page.goto('/admin?view=storage')
    await ready(page)
    await expect(page.locator('html')).toHaveClass(/\bdark\b/)
    const storage_heading = page.getByRole('heading', { name: '存储审计', level: 3, exact: true })
    await expect(storage_heading).toBeFocused()
    await expect(storage_heading).toBeInViewport()
    await expect_run_layout(page, 1)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await expect_compact_table(main.getByRole('region', { name: '后台任务', exact: true }).getByRole('table'), ['任务', '待办', '运行情况'])
    const findings_heading = page.getByRole('heading', { name: '异常明细', level: 2, exact: true })
    await expect(findings_heading).toBeVisible()
    const storage_card = main.getByRole('region', { name: '存储审计', exact: true })
    await expect(storage_card.getByRole('button', { name: '读取异常明细', exact: true })).toHaveCount(0)
    const findings_section = main.getByRole('region', { name: '异常明细', exact: true })
    const read_findings = findings_section.getByRole('button', { name: '读取异常明细', exact: true })
    await expect(read_findings).toBeVisible()
    expect(admin_detail_requests).toBe(0)
    await page.getByRole('main').locator(':scope > div').screenshot({
      path: test.info().outputPath('runtime-320-dark.png'), style: 'header.fixed { display: none !important; transition: none !important }',
    })
    const [response] = await Promise.all([page.waitForResponse(response => response.url().includes('getStorageAuditFindings')), read_findings.click()])
    expect(response.ok()).toBe(true)
    expect(admin_detail_requests).toBe(1)
    const refresh_findings = findings_section.getByRole('button', { name: '刷新', exact: true })
    await expect(refresh_findings).toBeVisible()

    const findings_route = '**/api/trpc/**admin.getStorageAuditFindings**'
    await page.route(findings_route, route => route.abort('blockedbyclient'))
    try {
      await refresh_findings.click()
      await expect(page.locator('.p-toast').getByText(/异常明细失败/)).toBeVisible()
      await expect(findings_section).not.toContainText(/异常明细失败/)
    }
    finally {
      await page.unroute(findings_route)
    }
    await page.keyboard.press('Escape')
    const [recovered] = await Promise.all([page.waitForResponse(response => response.url().includes('getStorageAuditFindings')), refresh_findings.click()])
    expect(recovered.ok()).toBe(true)
  })

  await test.step('the user view groups its controls, updates its own time and animates the filtered list', async () => {
    await views.getByRole('button', { name: '用户' }).click()
    await expect(page).toHaveURL(/\/admin$/)
    await expect_view_header('用户管理', settings.app.admin.pollIntervalSeconds)
    await page.setViewportSize({ width: 1280, height: 900 })
    await page.context().addCookies([{ name: settings.app.client.colorMode.cookieName, value: 'light', url: new URL(page.url()).origin }])
    const response = await page.reload()
    expect(response?.ok()).toBe(true)
    const server_header = await page.evaluate((html) => {
      const header = new DOMParser().parseFromString(html, 'text/html').querySelector('main header')
      return { title: header?.querySelector('h1')?.textContent?.trim(), updated: header?.querySelector('time')?.getAttribute('datetime') }
    }, await response!.text())
    expect(server_header.title).toBe('用户管理')
    expect(server_header.updated).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    await ready(page)
    const time = await expect_view_header('用户管理', settings.app.admin.pollIntervalSeconds)
    expect(mismatches).toEqual([])
    const command = main.getByRole('region', { name: '命令', exact: true })
    const list = main.getByRole('region', { name: '用户列表', exact: true })
    const input = command.locator('.p-card .p-autocomplete-input')
    await expect(input).toBeVisible()
    await expect(command.locator('.my-height-transition')).toHaveCount(1)
    const list_card = list.locator('.p-card').first()
    await expect(list_card.getByRole('button', { name: '刷新', exact: true })).toBeVisible()
    await expect(list_card.getByRole('group', { name: '批量操作' })).toBeVisible()
    await expect(list_card.locator('.p-paginator')).toBeVisible()
    const user_cards = main.getByRole('list', { name: '用户卡片' }).getByRole('listitem')
    await expect(user_cards.first()).toBeVisible()
    await expect(user_cards.locator('.my-height-transition')).toHaveCount(await user_cards.count())
    await main.locator(':scope > div').screenshot({
      path: test.info().outputPath('users-desktop-light.png'), mask: [user_cards.getByText(/^手机号\s/)],
      style: 'header.fixed { display: none !important; transition: none !important }',
    })
    await page.setViewportSize({ width: 320, height: 812 })
    await page.context().addCookies([{ name: settings.app.client.colorMode.cookieName, value: 'dark', url: new URL(page.url()).origin }])
    await page.reload()
    await ready(page)
    await expect(page.locator('html')).toHaveClass(/\bdark\b/)
    await expect_view_header('用户管理', settings.app.admin.pollIntervalSeconds)
    const controls_height = list_card.locator('.my-height-transition')
    const results_height = list.locator(':scope > .my-height-transition')
    await expect(results_height.getByRole('list', { name: '用户卡片' })).toBeVisible()
    for (const container of [controls_height, results_height])
      await expect.poll(() => container.evaluate(el => Math.abs(el.getBoundingClientRect().height - el.firstElementChild!.getBoundingClientRect().height))).toBeLessThan(1)
    const before = await controls_height.evaluate(el => el.getBoundingClientRect().height)
    expect(await results_height.evaluate(el => el.getBoundingClientRect().height)).toBeGreaterThan(0)
    const previous_update = await time.getAttribute('datetime')
    const transitions = await Promise.all([controls_height, results_height].map(observe_height))
    await input.fill('username = \'no_matching_e2e_user\'')
    await command.getByRole('button', { name: '执行筛选或命令' }).click()
    await expect(list_card.getByRole('status')).toHaveText('没有匹配的用户')
    for (const events of transitions) {
      await expect.poll(() => events.jsonValue()).toEqual(expect.arrayContaining(['transitionrun', 'transitionend']))
      await events.dispose()
    }
    expect(Math.abs(await controls_height.evaluate(el => el.getBoundingClientRect().height) - before)).toBeGreaterThan(1)
    await expect(results_height).toHaveCSS('height', '0px')
    await expect(time).not.toHaveAttribute('datetime', previous_update!)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await main.locator(':scope > div').screenshot({
      path: test.info().outputPath('users-320-dark.png'), style: 'header.fixed { display: none !important; transition: none !important }',
    })
    await views.getByRole('button', { name: '运行状态' }).click()
    await expect(page).toHaveURL(/\/admin\?view=status$/)
    await expect_view_header('运行状态', settings.app.admin.statusPollIntervalSeconds)
  })

  await test.step('a read-only viewer can request the audit details after viewing the summary', async () => {
    const reader_context = await browser.newContext({ baseURL: new URL(page.url()).origin })
    try {
      const reader = await reader_context.newPage()
      let detail_requests = 0
      reader.on('request', (request) => {
        if (request.url().includes('getStorageAuditFindings'))
          detail_requests ++
      })
      // Sign in with the fixture role already set. Live changes to a logged-in user's
      // permissions are exercised separately in account-sync.spec.ts.
      const list = await page.request.get('/api/trpc/admin.listUsers', { params: { input: JSON.stringify({ filter: 'username = \'user\'' }) } })
      expect(list.ok()).toBe(true)
      const { result } = await list.json() as { result: { data: AdminUserList } }
      const account = result.data.users.find(user => user.username === 'user')!
      expect(account).toBeDefined()
      const grant = (permissions: typeof account.permissions) => page.request.post('/api/trpc/admin.setPermissions', { data: { id: account.id, permissions } })
      expect((await grant([{ field: 'admin_access', level: 'readonly' }])).ok()).toBe(true)
      try {
        await login(reader, 'user')
        await reader.goto('/admin?view=storage')
        await ready(reader)
        await expect(reader.getByRole('heading', { name: '存储审计', level: 3, exact: true })).toBeFocused()
        const findings = reader.getByRole('region', { name: '异常明细', exact: true })
        const read_findings = findings.getByRole('button', { name: '读取异常明细', exact: true })
        await expect(read_findings).toBeVisible()
        expect(detail_requests).toBe(0)
        const [response] = await Promise.all([reader.waitForResponse(response => response.url().includes('getStorageAuditFindings')), read_findings.click()])
        expect(response.ok()).toBe(true)
        expect(detail_requests).toBe(1)
        await expect(findings.getByRole('list', { name: '对象异常记录' }).or(findings.getByText('当前存储桶没有未关闭的异常', { exact: true }))).toBeVisible()
      }
      finally {
        expect((await grant(account.permissions)).ok()).toBe(true)
      }
    }
    finally {
      await reader_context.close()
    }
  })
})

test('an administrator can grant, edit and remove a verification note', async ({ page }) => {
  await login(page)
  await page.goto('/admin')
  await ready(page)
  const card = page.getByRole('list', { name: '用户卡片' }).getByRole('listitem')
    .filter({ has: page.getByText('user', { exact: true }) })
  const dialog = page.getByRole('dialog', { name: '认证说明' })
  const note = dialog.getByRole('textbox')
  const save = dialog.getByRole('button', { name: '保存', exact: true })
  const edit = card.getByRole('button', { name: '修改认证', exact: true })
  const grant = card.getByRole('button', { name: '授予认证', exact: true })
  await grant.click()
  await save.click()
  await expect(page.getByText('请填写认证说明', { exact: true })).toBeVisible()
  await expect(dialog).toBeVisible()
  for (const value of ['首份认证说明', '更新后的认证说明']) {
    await note.fill(value)
    await save.click()
    await expect(dialog).toBeHidden()
    await expect(card.getByText('认证', { exact: true })).toBeVisible()
    await edit.click()
    await expect(note).toHaveValue(value)
  }
  await dialog.getByRole('button', { name: '移除认证', exact: true }).click()
  await expect(grant).toBeVisible()
  await expect(card.getByText('认证', { exact: true })).toHaveCount(0)
  await grant.click()
  await expect(note).toHaveValue('')
})

test('the user list polls after two visible seconds and pauses in a hidden tab', async ({ page }) => {
  await login(page)
  await page.clock.install()
  await page.goto('/admin')
  await ready(page)
  const interval = settings.app.admin.pollIntervalSeconds * 1000
  expect(interval).toBe(2000)
  let reads = 0
  page.on('request', (request) => {
    if (request.url().includes('admin.listUsers'))
      reads ++
  })
  const list_read = () => page.waitForResponse(response => response.url().includes('admin.listUsers') && response.ok())
  await Promise.all([list_read(), page.clock.fastForward(interval + 1000)])
  await set_page_visibility(page, 'hidden')
  await page.waitForLoadState('networkidle')
  const last_visible = reads
  await page.clock.fastForward(3 * interval)
  expect(reads).toBe(last_visible)
  const resumed = list_read()
  await set_page_visibility(page, 'visible')
  await page.clock.fastForward(interval + 1000)
  await resumed
  expect(reads).toBeGreaterThan(last_visible)
})

test('nonzero status examples show separate incident rows at desktop and mobile widths', async ({ page }) => {
  await login(page)
  await page.context().addCookies([{ name: settings.app.client.colorMode.cookieName, value: 'dark', url: new URL(page.url()).origin }])
  await page.goto('/admin?view=status')
  await ready(page)
  const main = page.getByRole('main')
  const attention = main.getByRole('region', { name: 'TODO', exact: true })
  await expect(main.getByRole('cell', { name: '存储对象清理', exact: true })).toBeVisible()
  const height = attention.locator('.my-height-transition')
  const transitions = await observe_height(height)
  const now = Date.now()
  const ago = (seconds: number) => new Date(now - seconds * 1000).toISOString()
  // Same blocked ledger, last-run error and findings used by the incident rule tests.
  const tasks = [
    { id: 'images', name: '图片处理', pending: 3, phase: 'running', status: '本轮运行中' },
    { id: 'uploads', name: '上传收尾', pending: 0, phase: 'idle', status: '空闲' },
    { id: 'retirement', name: '存储对象清理', pending: 4, phase: 'idle', status: '配置不完整' },
    { id: 'preload', name: '边缘预热', pending: 0, phase: 'idle', status: '空闲' },
    { id: 'sync', name: '同步通知', pending: 2, phase: 'idle', status: '空闲' },
    { id: 'receipts', name: '回执压缩', pending: 0, phase: 'idle', status: '空闲' },
    { id: 'storage_audit', name: '存储审计', pending: 0, phase: 'running', status: '本轮运行中' },
  ] as const
  const timings = [
    { stage: 'image_job', name: '图片处理', median: 240, p95: 810 },
    { stage: 'multipart_complete', name: '分片上传合并', median: 19, p95: 52 },
    { stage: 'db_acquire', name: '数据库取连接', median: 3, p95: 12 },
    { stage: 'upload_seal', name: '封存上传', median: 16, p95: 44 },
    { stage: 'sync_publish_ack', name: '发布并确认通知', median: 11, p95: 30 },
    { stage: 'image_queue', name: '图片排队', median: 7, p95: 14 },
    { stage: 'image_display', name: '生成展示图', median: 46, p95: 88 },
  ] as const
  const sample = {
    mode: 'app', blocked: { retirement: 'unconfigured' },
    process: {
      closed: false, resources: { image: { capacity: 1, used: 1 }, oss: { capacity: 2, used: 2 }, esa: { capacity: 1, used: 0 }, notification: { capacity: 1, used: 0 } },
      adapters: tasks.map(task => ({
        id: task.id, phase: task.phase, runs: 13, failures: task.id === 'images' ? 2 : 0,
        last_error_code: task.id === 'images' ? 'sweep_failed' : null,
        last_duration_ms: null, last_started_at: ago(8), last_finished_at: ago(65),
      })),
    },
    database: {
      ledgers: tasks.map(task => ({
        id: task.id, interval_seconds: 30,
        groups: task.pending
          ? [{ phase: 'queued', error_code: null, total: task.pending, pending: task.pending, due: Math.min(task.pending, 3), leased: 0, oldest_pending_at: ago(1920) }]
          : [],
      })),
      storage_audit: [{ destination_id: 'd06ce451'.padEnd(64, 'a'), phase: 'objects', references_checked: 1532, objects_checked: 4871,
        cycle_started_at: ago(3600), last_completed_at: ago(86400), next_run_at: ago(- 30), error_code: null }],
      storage_audit_findings: [{ kind: 'missing_object', total: 2 }, { kind: 'orphan_candidate', total: 1 }], preload_targets: [],
    },
    observations: timings.map((timing): Awaited<ReturnType<typeof get_background_status>>['observations'][number] => ({
      stage: timing.stage, count: 15, failed: 0, active: 0, peak_active: 2, total_ms: timing.median * 15, max_ms: timing.p95,
      recent_count: 15, recent_p50_ms: timing.median, recent_p95_ms: timing.p95,
    })),
    resources: { uptime_seconds: 266400, rss_bytes: 432 * 1024 ** 2, heap_used_bytes: 180 * 1024 ** 2, external_bytes: 0, cpu_user_ms: 9000, cpu_system_ms: 3300 },
  } satisfies Awaited<ReturnType<typeof get_background_status>>
  await page.route(/\/api\/trpc\/admin\.getBackgroundStatus(?:\?|$)/, async (route) => {
    const envelope = { result: { data: sample } }
    const batched = new URL(route.request().url()).searchParams.get('batch') === '1'
    await route.fulfill({ json: batched ? [envelope] : envelope })
  })
  const rows = attention.getByRole('listitem')
  await expect(rows).toHaveCount(4)
  for (const title of ['存储对象清理被阻塞', '图片处理上次扫描出错', '找不到引用的文件', '文件归属待确认'])
    await expect(attention.getByText(title, { exact: true })).toBeVisible()
  await expect(attention.getByRole('button', { name: /复制给 Agent/ })).toHaveCount(0)
  await expect(attention.getByRole('button', { name: /查看明细/ })).toHaveCount(2)
  const colors = await rows.evaluateAll(items => items.map(item => getComputedStyle(item).borderLeftColor))
  expect(new Set(colors).size).toBe(3)
  await expect.poll(() => transitions.jsonValue()).toEqual(expect.arrayContaining(['transitionrun', 'transitionend']))
  await transitions.dispose()
  const overview = main.getByRole('region', { name: '异常概况', exact: true })
  for (const [index, value] of ['1', '1', '3'].entries())
    await expect(overview.locator('.p-card').nth(index).getByText(value, { exact: true })).toBeVisible()
  await expect(main).not.toContainText('sweep_failed')
  const content = main.locator(':scope > div')
  const settled = () => expect.poll(() => content.locator('.my-height-transition').evaluateAll(items => Math.max(... items.map((item) => {
    const inner = item.firstElementChild!
    return Math.abs(item.getBoundingClientRect().height - inner.getBoundingClientRect().height)
  })))).toBeLessThan(1)
  async function expect_spacing() {
    const last_row = await rows.last().boundingBox()
    const details = await main.getByRole('heading', { name: '仪表盘', exact: true }).boundingBox()
    expect(details!.y - last_row!.y - last_row!.height).toBeLessThan(80)
  }
  const timing_card = main.getByRole('region', { name: '处理用时', exact: true })
  const timing_table = timing_card.getByRole('table')
  async function capture_example(filename: string, columns: 1 | 2) {
    await expect(rows).toHaveCount(4)
    await expect_run_layout(page, columns)
    const task_table = main.getByRole('region', { name: '后台任务', exact: true }).getByRole('table')
    await expect_compact_table(task_table, ['任务', '待办', '运行情况'])
    await expect_compact_table(timing_table, ['环节', '中位耗时', 'P95 耗时'])
    await expect(task_table.locator('tbody tr').first().getByRole('cell').first()).toHaveText('存储对象清理')
    for (const task of tasks) {
      const cells = task_table.getByRole('row').filter({ has: page.getByRole('cell', { name: task.name, exact: true }) }).getByRole('cell')
      await expect(cells).toHaveText([task.name, String(task.pending), task.status])
    }
    await expect(timing_table.locator('tbody tr')).toHaveCount(timings.length)
    await expect(timing_card.getByRole('button')).toHaveCount(0)
    await expect(timing_card).not.toContainText(/查看全部|只看主要|另有|还有/)
    const typography = await timing_card.evaluate((card) => {
      const heading = getComputedStyle(card.querySelector('h3')!)
      const body = getComputedStyle(card.querySelector('tbody td span')!)
      const note = getComputedStyle(card.querySelector('tbody td small')!)
      return {
        heading_larger: Number.parseFloat(heading.fontSize) > Number.parseFloat(body.fontSize),
        heading_heavier: Number(heading.fontWeight) > Number(body.fontWeight),
        note_smaller: Number.parseFloat(note.fontSize) < Number.parseFloat(body.fontSize),
        colors: [heading.color, body.color, note.color],
      }
    })
    expect(typography.heading_larger && typography.heading_heavier && typography.note_smaller).toBe(true)
    expect(new Set(typography.colors).size).toBe(3)
    for (const [index, timing] of timings.entries()) {
      const cells = timing_table.locator('tbody tr').nth(index).getByRole('cell')
      await expect(cells).toHaveText([new RegExp(`^${timing.name}\\s*最近 15 次$`), `${timing.median} 毫秒`, `${timing.p95} 毫秒`])
    }
    if (columns === 1) {
      await expect(rows.first().getByRole('button')).toHaveCount(0)
      for (const label of [rows.first().getByRole('heading'), timing_table.getByRole('cell', { name: '240 毫秒', exact: true })]) {
        const line_count = await label.evaluate((el) => {
          const range = document.createRange()
          range.selectNodeContents(el)
          return new Set([... range.getClientRects()].map(rect => Math.round(rect.top))).size
        })
        expect(line_count).toBe(1)
      }
    }
    const storage = main.getByRole('region', { name: '存储审计', exact: true })
    const counts = storage.locator('dl').filter({ has: page.getByText('已核对引用', { exact: true }) })
    await expect(counts.locator('dd')).toHaveText(['1,532', '4,871'])
    expect(await counts.evaluate(el => Number.parseFloat(getComputedStyle(el.querySelector('dd')!).fontSize)
      > Number.parseFloat(getComputedStyle(el.querySelector('dt')!).fontSize))).toBe(true)
    const process_card = main.getByRole('region', { name: '当前进程', exact: true })
    await expect(process_card.getByText('后台并发名额', { exact: true })).toBeVisible()
    await expect(process_card.getByText('已用 / 上限', { exact: true })).toBeVisible()
    await expect(process_card.getByRole('progressbar')).toHaveCount(4)
    for (const [name, reading] of [['图片处理', '已用 1，容量 1'], ['对象存储', '已用 2，容量 2'], ['边缘服务', '已用 0，容量 1'], ['同步通知', '已用 0，容量 1']])
      await expect(process_card.getByRole('progressbar', { name: `${name}并发占用` })).toHaveAttribute('aria-valuetext', reading)
    const bar = await process_card.getByRole('progressbar', { name: '图片处理并发占用' }).boundingBox()
    expect(bar!.width).toBeGreaterThan(2 * bar!.height)
    // Capture settled content at the actual display width, including the final detail card.
    const viewport = page.viewportSize()!
    await settled()
    await expect_spacing()
    const chrome = await page.addStyleTag({ content: 'header.fixed { display: none !important; transition: none !important }' })
    try {
      await page.evaluate(() => window.scrollTo(0, 0))
      const bottom = await content.evaluate(el => Math.ceil(el.getBoundingClientRect().bottom + window.scrollY))
      await page.setViewportSize({ width: viewport.width, height: Math.max(viewport.height, bottom + 16) })
      await settled()
      await expect_spacing()
      const clip = await content.boundingBox()
      expect(clip!.y + clip!.height).toBeLessThanOrEqual(page.viewportSize()!.height)
      // Keep the console's normal desktop and mobile gutters around the full view.
      const frame = await main.boundingBox()
      await page.screenshot({ path: test.info().outputPath(filename), clip: { x: frame!.x, width: frame!.width, y: clip!.y, height: clip!.height } })
    }
    finally {
      await chrome.evaluate(el => el.parentNode?.removeChild(el))
      await page.setViewportSize(viewport)
    }
  }
  // A poll can replace an empty issue list with populated cards while the page stays open.
  await settled()
  await expect_spacing()
  // A poll that grows the storage card beyond the task card must move the next card to the shorter column.
  const storage_card = main.getByRole('region', { name: '存储审计', exact: true })
  const process_card = main.getByRole('region', { name: '当前进程', exact: true })
  const first_bucket = sample.database.storage_audit.pop()!
  await expect(storage_card.getByText('1,532', { exact: true })).toHaveCount(0, { timeout: 15000 })
  await settled()
  await expect_run_layout(page, 2)
  const initial_column = (await process_card.boundingBox())!.x
  const initial_card_height = (await timing_card.boundingBox())!.height
  await expect(timing_table.locator('tbody tr')).toHaveCount(timings.length)
  sample.database.storage_audit.push(first_bucket, ... ['6e31bc7f', 'b3470a61'].map(id => ({ ... first_bucket, destination_id: id.padEnd(64, 'c') })))
  sample.observations.push({ stage: 'image_source_info', count: 1, failed: 0, active: 0, peak_active: 1,
    total_ms: 5, max_ms: 5, recent_count: 1, recent_p50_ms: 5, recent_p95_ms: 5 })
  await expect(storage_card.getByText('1,532', { exact: true })).toHaveCount(3, { timeout: 15000 })
  await expect(timing_table.getByText('读取原图信息', { exact: true })).toBeVisible()
  await expect(timing_table.locator('tbody tr')).toHaveCount(timings.length + 1)
  await settled()
  await expect_run_layout(page, 2)
  expect(Math.abs((await process_card.boundingBox())!.x - initial_column)).toBeGreaterThan(100)
  expect((await timing_card.boundingBox())!.height).toBeGreaterThan(initial_card_height)
  sample.database.storage_audit.splice(1)
  sample.observations.pop()
  await expect(storage_card.getByText('1,532', { exact: true })).toHaveCount(1, { timeout: 15000 })
  await expect(timing_table.locator('tbody tr')).toHaveCount(timings.length)
  await settled()
  await expect_run_layout(page, 2)
  await expect(page.locator('html')).toHaveClass(/\bdark\b/)
  await capture_example('runtime-masonry-desktop-dark.png', 2)
  const toggle_theme = page.getByRole('button', { name: '切换浅色 / 深色模式' })
  await toggle_theme.click()
  await expect(page.locator('html')).not.toHaveClass(/\bdark\b/)
  await capture_example('runtime-masonry-desktop-light.png', 2)
  for (const [width, columns] of [[768, 2], [767, 1]] as const) {
    await page.setViewportSize({ width, height: 900 })
    await expect_run_layout(page, columns)
  }
  await page.setViewportSize({ width: 320, height: 812 })
  await toggle_theme.click()
  await expect(page.locator('html')).toHaveClass(/\bdark\b/)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await capture_example('runtime-masonry-320-dark.png', 1)

  const findings = main.getByRole('region', { name: '异常明细', exact: true })
  const read = () => page.waitForResponse(response => response.url().includes('admin.getStorageAuditFindings'))
  const [filtered] = await Promise.all([read(), attention.getByRole('button', { name: '查看明细：找不到引用的文件', exact: true }).click()])
  expect(filtered.ok()).toBe(true)
  expect(new URL(filtered.url()).searchParams.get('input')).toContain('"kinds":["missing_object"]')
  await expect(findings.getByRole('heading')).toBeFocused()
  const filters = findings.getByRole('group', { name: '按异常类型筛选' })
  const missing = filters.getByRole('button', { name: '对象缺失', exact: true })
  const orphan = filters.getByRole('button', { name: '疑似无主对象', exact: true })
  await expect(missing).toHaveAttribute('aria-pressed', 'true')
  await expect(orphan).toHaveAttribute('aria-pressed', 'false')
  const [both] = await Promise.all([read(), orphan.click()])
  expect(both.ok()).toBe(true)
  expect(new URL(both.url()).searchParams.get('input')).toContain('"orphan_candidate"')
  expect(new URL(both.url()).searchParams.get('input')).toContain('"missing_object"')
  await expect(orphan).toHaveAttribute('aria-pressed', 'true')
  const clear = filters.getByRole('button', { name: '清除', exact: true })
  const [all] = await Promise.all([read(), clear.click()])
  expect(all.ok()).toBe(true)
  expect(new URL(all.url()).searchParams.get('input')).not.toContain('"missing_object"')
  await expect(clear).toHaveCount(0)
  await expect(missing).toHaveAttribute('aria-pressed', 'false')
})
