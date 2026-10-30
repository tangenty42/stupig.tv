import { readFile } from 'node:fs/promises'
import { expect } from '@playwright/test'
import { production_css_targets } from '../../config/browser-targets'
import { style_root_id } from '../../config/ui-style'
import { login, ready, test } from '../support/e2e-browser'

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

test('shared form and admin controls preserve local styles across themes', async ({ page }, info) => {
  test.skip(! info.config.metadata.productionCss, 'Run with tests/css-production.config.ts')
  await page.goto('/content')
  await ready(page)
  await page.getByRole('button', { name: '登录 / 注册', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toHaveCSS('max-width', '448px')
  await expect(dialog).toHaveCSS('border-radius', '6.4px')
  await dialog.getByText('手机验证码登录', { exact: true }).click()
  const addon = dialog.locator('.p-inputgroupaddon:visible')
  await expect(addon).toHaveCSS('padding-left', '24px')
  await expect(addon).toHaveCSS('padding-right', '24px')
  await expect(addon.getByRole('button')).toHaveCSS('font-size', '14px')
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
  const execute = page.getByRole('button', { name: '执行', exact: true })
  await execute.hover()
  await expect(execute).toHaveCSS('color', initial_dark ? 'rgb(2, 132, 199)' : 'rgb(56, 189, 248)')
})
