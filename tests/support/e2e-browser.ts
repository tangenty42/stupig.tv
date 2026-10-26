import type { Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { test as base, expect } from '@playwright/test'

export const test = base.extend({
  page: async ({ page, baseURL }, use) => {
    if (! baseURL)
      throw new Error('E2E base URL is required')
    const origin = new URL(baseURL).origin
    const failures: string[] = []
    page.on('pageerror', error => failures.push(error.message))
    page.on('response', (response) => {
      if (new URL(response.url()).origin === origin && response.status() >= 500)
        failures.push(`HTTP ${response.status()} ${new URL(response.url()).pathname}`)
    })
    await page.addInitScript(() => {
      const state = window as Window & { __hide_app_loading_mask?: () => void, __STUPIG_E2E_MASK_DEADLINE__?: number, __STUPIG_E2E_MASK_DISMISSED_AT__?: number }
      const timers: Window = window
      const schedule = timers.setTimeout.bind(timers)
      timers.setTimeout = (handler, timeout, ... args) => {
        if (typeof handler === 'function' && handler === state.__hide_app_loading_mask) {
          state.__STUPIG_E2E_MASK_DEADLINE__ = performance.now() + (timeout ?? 0)
          state.__hide_app_loading_mask = () => {
            state.__STUPIG_E2E_MASK_DISMISSED_AT__ ??= performance.now()
            handler()
          }
        }
        return schedule(handler, timeout, ... args)
      }
    })
    await use(page)
    expect(failures).toEqual([])
  },
})

export async function ready(page: Page) {
  await page.waitForFunction(() => (window as unknown as { __STUPIG_E2E_READY__?: () => boolean }).__STUPIG_E2E_READY__?.(), undefined, { timeout: 15_000 })
  const timing = await page.evaluate(() => {
    const state = window as Window & { __STUPIG_E2E_MASK_DEADLINE__?: number, __STUPIG_E2E_HYDRATED_AT__?: number, __STUPIG_E2E_MASK_DISMISSED_AT__?: number }
    return { hydrated: state.__STUPIG_E2E_HYDRATED_AT__ ?? performance.now(), deadline: state.__STUPIG_E2E_MASK_DEADLINE__ ?? null, dismissed: state.__STUPIG_E2E_MASK_DISMISSED_AT__ ?? null }
  })
  if (timing.deadline !== null) {
    expect(timing.hydrated).toBeLessThan(timing.deadline)
    expect(timing.dismissed).not.toBeNull()
    expect(timing.dismissed).toBeLessThan(timing.deadline)
  }
  await expect(page.locator('#app-loading-mask')).toHaveCount(0, { timeout: 2000 })
}

export async function login(page: Page, username = 'admin', password = 'AaAaAaAa888') {
  await page.goto('/content')
  await ready(page)
  await page.getByRole('button', { name: '登录 / 注册', exact: true }).click()
  const form = page.locator('#login-password-form')
  await form.locator('input[name="username_or_phone"]').fill(username)
  await form.locator('input[type="password"]').fill(password)
  await form.locator('input[type="password"]').press('Tab')
  await expect(form.locator('input[type="password"]')).toHaveValue(password)
  await page.getByRole('button', { name: '立即登录', exact: true }).click()
  await expect(page.getByRole('button', { name: /^用户菜单：/ })).toBeVisible()
  await expect(page.getByRole('button', { name: '登录 / 注册', exact: true })).toHaveCount(0)
}

export async function create_story(page: Page) {
  const title = `E2E${randomUUID().slice(0, 8)}`
  await page.goto('/content/new/edit')
  await ready(page)
  const editor = page.getByRole('textbox', { name: '档案内容 Markdown 编辑器', exact: true })
  await expect(editor).toBeVisible()
  await editor.fill(markdown(title, 'E2E initial body'))
  await page.getByRole('button', { name: '创建', exact: true }).click()
  await expect(page).toHaveURL(/\/content\/\d+(?:\/edit)?$/)
  return { title, id: /\/content\/(\d+)/.exec(page.url())![1] }
}

export async function logout(page: Page) {
  await page.getByRole('button', { name: /^用户菜单：/ }).hover()
  await page.getByRole('button', { name: '退出登录', exact: true }).click()
  await expect(page.getByText('确定要退出登录吗？', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '确定', exact: true }).click()
  await expect(page.getByRole('button', { name: '登录 / 注册', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: /^用户菜单：/ })).toHaveCount(0)
}

export function markdown(title: string, body: string) {
  return `---\ntitle: ${title}\nlabel: #人上人\ntime: 2026/01/01\n---\n\n${body}\n`
}
