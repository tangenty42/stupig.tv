import { readFile } from 'node:fs/promises'
import { expect } from '@playwright/test'
import { production_css_targets } from '../../config/browser-targets'
import { style_root_id } from '../../config/ui-style'
import { login, ready, test } from '../support/e2e-browser'

test('the home introduction and archive link fit above the fold on short phones', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 460 })
  await page.goto('/')
  await expect(page.locator('#app-loading-mask')).toHaveCount(0)
  await page.evaluate(() => document.fonts.ready.then(() => {}))
  const main = page.getByRole('main')
  const introduction = ['我们是', '蠢猪', '小组', '我们来自', '广州市西关外国语学校', '2026届', '高三1班']
    .map(text => main.getByText(text, { exact: true }))
  const archive = main.getByRole('link', { name: /^快查看『蠢猪档案』\s*了解我们$/ })

  for (const [width, height] of [[320, 460], [390, 667], [568, 320]] as const) {
    await test.step(`${width} × ${height}`, async () => {
      await page.setViewportSize({ width, height })
      const header = (await page.getByRole('banner').boundingBox())!
      expect((await introduction[0]!.boundingBox())!.y).toBeGreaterThan(header.y + header.height)
      for (const item of [... introduction, archive])
        await expect(item).toBeInViewport({ ratio: 1 })
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    })
  }
})

test('production CSS survives SSR and hydration with all six heading levels', async ({ page, browser, baseURL }, info) => {
  test.skip(! info.config.metadata.productionCss, 'Run with tests/css-production.config.ts')
  const report_path = process.env.STUPIG_E2E_CSS_REPORT
  expect(report_path).toBeTruthy()
  const report = JSON.parse(await readFile(report_path!, 'utf8'))
  expect(report.nodeEnv).toBe('production')
  expect(report.browserslistEnv).toBe('production')
  expect(report.cssTarget).toEqual(production_css_targets)
  expect(report.cssMinify).toBe('lightningcss')
  expect(report.cssCodeSplit).toBe(true)
  expect(report.minify).toBeTruthy()
  expect(report.plugins.some((name: string) => name.includes('legacy'))).toBe(true)
  expect(report.assets.css.length).toBeGreaterThan(1)
  expect(report.assets.legacy.length).toBeGreaterThan(0)
  await info.attach('resolved-production-css', { body: JSON.stringify(report, null, 2), contentType: 'application/json' })

  const html = await (await page.request.get('/css-production')).text()
  expect(html).toContain('nomodule')
  const context = await browser.newContext({ javaScriptEnabled: false })
  try {
    const ssr = await context.newPage()
    await ssr.goto(`${baseURL}/css-production`)
    await expect(ssr.getByTestId('css-hydration')).toHaveText('server')
    expect(await ssr.locator('body').getAttribute('id')).toBe(style_root_id)
    expect(await ssr.locator('.story-body :is(h1,h2,h3,h4,h5,h6)').evaluateAll(nodes => nodes.map(node => getComputedStyle(node).zIndex))).toEqual(['30', '29', '28', '27', '26', '25'])
  }
  finally {
    await context.close()
  }

  await page.goto('/css-production')
  await ready(page)
  await expect(page.getByTestId('css-hydration')).toHaveText('client')
  expect(await page.locator('body').getAttribute('id')).toBe(style_root_id)
  expect(await page.locator('.story-body :is(h1,h2,h3,h4,h5,h6)').evaluateAll(nodes => nodes.map(node => getComputedStyle(node).zIndex))).toEqual(['30', '29', '28', '27', '26', '25'])
  const selected = page.locator('.p-paginator-page-selected')
  await expect(selected).toHaveText('1')
  await expect(selected).toHaveCSS('color', 'rgb(255, 255, 255)')
  await page.locator('.p-paginator-page').filter({ hasText: /^2$/ }).click()
  await expect(selected).toHaveText('2')
  await expect(selected).toHaveCSS('color', 'rgb(255, 255, 255)')
})

test('OTP send button stays flush with the input in both themes and cooldown states', async ({ page }) => {
  const ready_phone = '13800000000'
  const cooling_phone = '13800000001'
  await page.route(/\/api\/trpc\/auth\.getOtpCooldown\?/, async (route) => {
    const url = new URL(route.request().url())
    const input = JSON.parse(url.searchParams.get('input') ?? '{}')
    const cooling = input[0]?.phone === cooling_phone
    await route.fulfill({ json: [{ result: { data: {
      can_send: ! cooling,
      next_available_at: cooling ? new Date(Date.now() + 30 * 60_000).toISOString() : null,
      channels: { phone: null, identity: null },
    } } }] })
  })

  await page.setViewportSize({ width: 320, height: 720 })
  await page.goto('/content')
  await ready(page)
  const initial_dark = await page.locator('html').evaluate(node => node.classList.contains('dark'))
  for (const dark of [initial_dark, ! initial_dark]) {
    await test.step(dark ? 'Dark theme' : 'Light theme', async () => {
      if (dark !== initial_dark)
        await page.getByRole('button', { name: '切换浅色 / 深色模式', exact: true }).click()
      await expect(page.locator('html')).toHaveClass(dark ? /\bdark\b/ : /\blight\b/)
      await page.getByRole('button', { name: '登录 / 注册', exact: true }).click()
      const dialog = page.getByRole('dialog')
      await dialog.getByText('手机验证码登录', { exact: true }).click()
      const form = dialog.locator('#login-phone-form')
      const phone = form.locator('input[name="phone"]')
      const input = form.locator('input[autocomplete="one-time-code"]')
      const group = form.locator('.p-inputgroup')
      const button = group.getByRole('button')
      await expect(phone).toBeVisible()

      for (const cooling of [false, true]) {
        await phone.fill(cooling ? cooling_phone : ready_phone)
        await expect(button).toHaveText(cooling ? /\d+ 分钟/ : '发送')
        if (cooling)
          await expect(button).toBeDisabled()
        else
          await expect(button).toBeEnabled()
        await input.fill('123456')
        await expect(button).toHaveCSS('font-size', '14px')
        const [input_box, button_box] = await group.evaluate(element => [
          element.querySelector('input[autocomplete="one-time-code"]')!.getBoundingClientRect().toJSON(),
          element.querySelector('button')!.getBoundingClientRect().toJSON(),
        ])
        expect(button_box.x).toBeCloseTo(input_box.x + input_box.width, 1)
        expect(button_box.y).toBeCloseTo(input_box.y, 1)
        expect(button_box.height).toBeCloseTo(input_box.height, 1)
        expect(button_box.x + button_box.width).toBeLessThanOrEqual(320)
        await expect(button).toHaveCSS('border-inline-start-width', '0px')
        if (! cooling) {
          await button.hover()
          await expect(button).toHaveCSS('border-inline-start-width', '0px')
        }
      }
      await page.keyboard.press('Escape')
      await expect(dialog).toHaveCount(0)
    })
  }
})

test('shared dialog and admin controls preserve local styles across themes', async ({ page }, info) => {
  test.skip(! info.config.metadata.productionCss, 'Run with tests/css-production.config.ts')
  await page.goto('/content')
  await ready(page)
  await page.getByRole('button', { name: '登录 / 注册', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toHaveCSS('max-width', '448px')
  await expect(dialog).toHaveCSS('border-radius', '6.4px')
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await login(page)
  await page.goto('/admin')
  await ready(page)
  const command = page.locator('.p-autocomplete-input')
  await expect(command).toHaveCSS('font-size', '14px')
  expect(await command.evaluate(node => getComputedStyle(node).fontFamily)).toContain('monospace')
  await expect(command).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
  const initial_dark = await page.evaluate(() => document.documentElement.classList.contains('dark'))
  await expect(command).toHaveCSS('color', initial_dark ? 'rgb(226, 232, 240)' : 'rgb(30, 41, 59)')
  await page.getByRole('button', { name: '切换浅色 / 深色模式', exact: true }).click()
  await expect(command).toHaveCSS('color', initial_dark ? 'rgb(30, 41, 59)' : 'rgb(226, 232, 240)')
  const execute = page.getByRole('button', { name: '执行筛选或命令', exact: true })
  await execute.hover()
  await expect(execute).toHaveCSS('color', initial_dark ? 'rgb(2, 132, 199)' : 'rgb(56, 189, 248)')
})
