import { expect } from '@playwright/test'
import { ready, test } from '../support/e2e-browser'

test('late production CSS preserves lazy overlays and their animations', async ({ page }, info) => {
  test.skip(! info.config.metadata.productionCss, 'Run with tests/css-production.config.ts')
  await page.addInitScript(() => {
    const state = window as Window & { __CSS_ANIMATIONS__?: string[] }
    state.__CSS_ANIMATIONS__ = []
    document.addEventListener('animationstart', (event) => {
      if (['card-in', 'card-out', 'p-confirmpopup-enter'].includes(event.animationName))
        state.__CSS_ANIMATIONS__!.push(event.animationName)
    }, true)
  })
  await page.goto('/css-production-start')
  await ready(page)

  // Hold the next route's actual CSS response until the navigation has begun.
  // This exercises the built preload chain without replacing any style rules.
  const route_css = Promise.withResolvers<void>()
  const route_request = page.waitForRequest(request => request.resourceType() === 'stylesheet')
  await page.route('**/_nuxt/*.css', async (route) => {
    await route_css.promise
    await route.continue()
  })
  try {
    await page.getByRole('link', { name: '打开生产样式验收页' }).click()
    await route_request
    await expect(page.getByTestId('css-hydration')).toHaveCount(0)
  }
  finally {
    route_css.resolve()
  }
  await expect(page.getByTestId('css-hydration')).toHaveText('client')
  await page.unroute('**/_nuxt/*.css')

  const lazy_css = Promise.withResolvers<void>()
  const lazy_request = page.waitForRequest(request => request.resourceType() === 'stylesheet')
  await page.route('**/_nuxt/*.css', async (route) => {
    await lazy_css.promise
    await route.continue()
  })
  try {
    await page.getByRole('button', { name: '首次打开懒加载弹窗' }).click()
    await lazy_request
    await expect(page.getByRole('dialog', { name: '生产懒加载弹窗' })).toHaveCount(0)
  }
  finally {
    lazy_css.resolve()
  }
  const dialog = page.getByRole('dialog', { name: '生产懒加载弹窗' })
  await expect(dialog).toBeVisible()
  await expect(dialog).toHaveCSS('width', '321px')
  await expect(dialog).toHaveCSS('border-radius', '6.4px')
  await expect(dialog.locator('.p-dialog-content')).toHaveCSS('padding-left', '0px')
  await expect(dialog.locator('.production-dialog-content')).toHaveCSS('min-height', '32px')
  expect(await dialog.evaluate(node => node.closest('#__nuxt') === null)).toBe(true)
  const animations = () => page.evaluate(() => (window as Window & { __CSS_ANIMATIONS__?: string[] }).__CSS_ANIMATIONS__)
  await expect.poll(animations).toContain('card-in')
  await dialog.getByRole('button', { name: '关闭', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect.poll(animations).toContain('card-out')
  await page.unroute('**/_nuxt/*.css')

  await page.getByRole('button', { name: '打开确认浮层' }).click()
  const popup = page.locator('.p-confirmpopup')
  await expect(popup).toBeVisible()
  await expect(popup).toHaveCSS('transform', 'none')
  await expect.poll(animations).toContain('p-confirmpopup-enter')
  const trigger = page.getByRole('button', { name: '打开确认浮层', exact: true })
  await expect.poll(async () => {
    const target = await trigger.boundingBox()
    const overlay = await popup.boundingBox()
    if (! target || ! overlay)
      return false
    const bottom = target.y + target.height
    return overlay.y >= bottom - 2 && overlay.y <= bottom + 16
      && overlay.x < target.x + target.width && overlay.x + overlay.width > target.x
  }).toBe(true)
  await popup.getByRole('button', { name: '确定', exact: true }).click()
  await expect(page.getByTestId('css-confirm-result')).toHaveText('confirmed')
})
