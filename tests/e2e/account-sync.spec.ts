import type { Page } from '@playwright/test'
import { expect } from '@playwright/test'
import { settings } from '@shared/settings'
import { login, ready, set_page_visibility, test } from '../support/e2e-browser'

async function query<T>(page: Page, path: string) {
  const response = await page.request.get(`/api/trpc/${path}`)
  expect(response.ok()).toBe(true)
  return (await response.json()).result.data as T
}

async function mutate(page: Page, path: string, input: object) {
  const response = await page.request.post(`/api/trpc/${path}`, { data: input })
  expect(response.ok()).toBe(true)
}

async function control_panel(page: Page) {
  await page.getByRole('button', { name: '用户菜单：user', exact: true }).hover()
  return page.getByRole('link', { name: '控制台', exact: true })
}

test('account changes and revocation reach another browser through real MQTT', async ({ page, browser }) => {
  await login(page)
  const reader_context = await browser.newContext({ baseURL: new URL(page.url()).origin })
  try {
    const reader = await reader_context.newPage()
    let received = false
    reader.on('websocket', socket => socket.on('framereceived', ({ payload }) => {
      if (Buffer.isBuffer(payload) && (payload[0]! & 0xF0) === 0x30 && payload.includes(Buffer.from('auth_user:')))
        received = true
    }))
    await login(reader, 'user')
    const user = await query<{ id: number }>(reader, 'profile.getMe')
    await mutate(page, 'admin.setPermissions', { id: user.id, permissions: [] })
    await expect(await control_panel(reader)).toHaveCount(0)
    received = false
    await mutate(page, 'admin.setPermissions', { id: user.id, permissions: [{ field: 'admin_access', level: 'readonly' }] })
    await expect.poll(() => received).toBe(true)
    await expect(await control_panel(reader)).toBeVisible({ timeout: 10_000 })
    await mutate(page, 'admin.setPermissions', { id: user.id, permissions: [] })
    await expect(reader.getByRole('link', { name: '控制台', exact: true })).toHaveCount(0)
    await mutate(page, 'admin.forceLogout', { id: user.id })
    await expect(reader.getByRole('button', { name: '登录 / 注册', exact: true })).toBeVisible()
    expect((await reader.request.get('/api/trpc/profile.getMe')).status()).toBe(401)
  }
  finally {
    await reader_context.close()
  }
})

test('lost account notifications converge by visible polling and visibility recovery without a broker', async ({ page, browser }) => {
  await login(page)
  const reader_context = await browser.newContext({ baseURL: new URL(page.url()).origin })
  try {
    let dropped = 0
    let connected = 0
    let broker_available = true
    await reader_context.routeWebSocket(/\/mqtt(?:[/?]|$)/, (socket) => {
      if (! broker_available) {
        socket.close()
        return
      }
      const server = socket.connectToServer()
      server.onMessage((message) => {
        const bytes = Buffer.isBuffer(message) ? message : Buffer.from(message)
        if ((bytes[0]! & 0xF0) === 0x30) {
          dropped ++
          return
        }
        if ((bytes[0]! & 0xF0) === 0x20)
          connected ++
        socket.send(message)
      })
    })
    const reader = await reader_context.newPage()
    await reader.clock.install()
    await login(reader, 'user')
    await reader.goto('/contact')
    await ready(reader)
    const user = await query<{ id: number }>(reader, 'profile.getMe')
    await mutate(page, 'admin.setPermissions', { id: user.id, permissions: [] })
    await expect(await control_panel(reader)).toHaveCount(0)
    // Observe the app's own read after its initial subscription is acknowledged.
    let reads = 0
    const read_connections: number[] = []
    reader.on('request', (request) => {
      if (request.url().includes('profile.getMe'))
        read_connections.push(connected)
    })
    reader.on('response', (response) => {
      if (response.url().includes('profile.getMe'))
        reads ++
    })
    await reader.clock.fastForward((settings.app.auth.syncPollIntervalSeconds + 1) * 1000)
    await expect.poll(() => reads).toBeGreaterThan(0)
    const connections_before = connected
    const reads_before = reads
    const read_connections_before = read_connections.length
    await mutate(page, 'admin.setPermissions', { id: user.id, permissions: [{ field: 'admin_access', level: 'readonly' }] })
    await expect.poll(() => dropped).toBeGreaterThan(0)
    await expect(await control_panel(reader)).toHaveCount(0)
    await reader.clock.fastForward((settings.app.auth.syncPollIntervalSeconds + 1) * 1000)
    await expect(await control_panel(reader)).toBeVisible()
    expect(reads).toBeGreaterThan(reads_before)
    expect(read_connections[read_connections_before]).toBe(connections_before)

    // No tab forwards events and the hidden reader closes its MQTT connection.
    broker_available = false
    await set_page_visibility(reader, 'hidden')
    await mutate(page, 'admin.setPermissions', { id: user.id, permissions: [] })
    const hidden_reads = reads
    await reader.clock.fastForward((settings.app.auth.syncPollIntervalSeconds + 1) * 1000)
    expect(reads).toBe(hidden_reads)
    await set_page_visibility(reader, 'visible')
    await expect(reader.getByRole('link', { name: '控制台', exact: true })).toHaveCount(0)

    await mutate(page, 'admin.forceLogout', { id: user.id })
    await reader.clock.fastForward((settings.app.auth.syncPollIntervalSeconds + 1) * 1000)
    await expect(reader.getByRole('button', { name: '登录 / 注册', exact: true })).toBeVisible()
    expect((await reader.request.get('/api/trpc/profile.getMe')).status()).toBe(401)
  }
  finally {
    await reader_context.close()
  }
})
