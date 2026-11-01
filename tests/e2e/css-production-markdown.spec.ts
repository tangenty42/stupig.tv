import { expect } from '@playwright/test'
import { ready, test } from '../support/e2e-browser'

test('mixed media retains captions, bottom alignment and independent card-only scroll state', async ({ page }, info) => {
  await page.route('https://player.bilibili.com/player.html*', route => route.fulfill({ contentType: 'text/html', body: '<html><body>Player ready</body></html>' }))
  await page.goto('/markdown-layout')
  await ready(page)
  const root = page.getByTestId('layout-preview')
  const strips = root.locator('.image-carousel')
  await expect(strips).toHaveCount(3)
  const mixed = strips.first()
  await expect(mixed.locator(':scope > *')).toHaveCount(8)
  await expect(mixed.locator('.carousel-caption')).toHaveCount(5)
  await expect(mixed.locator('.encrypted-image-denied')).toHaveCount(1)
  await expect(mixed.locator('.encrypted-block-brand-text')).toHaveText(['机密附件·完整版', '机密附件·删减版'])
  await expect(mixed.locator('.img-frame[data-image-loaded]')).toHaveCount(4)
  await expect(root.locator('p .carousel-item .carousel-caption')).toHaveText('Inline caption')
  await expect(root.locator('p').filter({ hasText: 'Before' })).toContainText('normal prose')
  await expect(root.locator('p').filter({ hasText: 'after' })).toContainText('normal prose')

  for (const narrow of [false, true]) {
    if (narrow)
      await page.getByTestId('layout-narrow').click()
    for (const theme of ['light', 'dark']) {
      await page.evaluate(value => document.documentElement.classList.toggle('dark', value === 'dark'), theme)
      const geometry = await mixed.evaluate((strip) => {
        const items = [... strip.children].map((element) => {
          const rect = element.getBoundingClientRect()
          const private_body = element.querySelector('.encrypted-block')?.getBoundingClientRect()
          const caption = element.querySelector('.carousel-caption')?.getBoundingClientRect()
          return { left: rect.left, right: rect.right, bottom: rect.bottom, privateBottom: private_body?.bottom, captionBottom: caption?.bottom, width: rect.width }
        })
        const parent = strip.closest('[data-testid="layout-preview"]')!.getBoundingClientRect()
        return { items, right: strip.getBoundingClientRect().right, parentRight: parent.right, width: strip.clientWidth, max: strip.scrollWidth - strip.clientWidth }
      })
      expect(geometry.max).toBeGreaterThan(0)
      expect(geometry.right).toBeLessThanOrEqual(geometry.parentRight + 1)
      for (const [index, item] of geometry.items.entries()) {
        expect(item.bottom).toBeCloseTo(geometry.items[0]!.bottom, 0)
        expect(item.width).toBeLessThanOrEqual(geometry.width + 1)
        if (index)
          expect(item.left - geometry.items[index - 1]!.right).toBeCloseTo(12, 0)
        if (item.privateBottom !== undefined)
          expect(item.privateBottom).toBeCloseTo(item.bottom, 0)
        if (item.captionBottom !== undefined)
          expect(item.captionBottom).toBeCloseTo(item.bottom, 0)
      }
      await page.screenshot({ path: info.outputPath(`mixed-${narrow ? 'narrow' : 'wide'}-${theme}.png`) })
    }
  }

  const first_cards = strips.nth(1)
  const second_cards = strips.nth(2)
  await first_cards.evaluate(element => element.scrollLeft = 120)
  await expect.poll(() => first_cards.evaluate(element => element.scrollLeft)).toBe(120)
  await second_cards.evaluate(element => element.scrollLeft = 60)
  await expect.poll(() => second_cards.evaluate(element => element.scrollLeft)).toBe(60)
  // Native scroll events must settle before unmount captures the snapshots.
  await expect(first_cards.locator('..').locator('.carousel-prev')).toHaveAttribute('data-on', 'true')
  await expect(second_cards.locator('..').locator('.carousel-prev')).toHaveAttribute('data-on', 'true')
  await page.getByTestId('layout-remount').click()
  await expect.poll(() => strips.nth(1).evaluate(element => element.scrollLeft)).toBe(120)
  await expect.poll(() => strips.nth(2).evaluate(element => element.scrollLeft)).toBe(60)
  await mixed.locator('..').locator('.carousel-next').click()
  await expect.poll(() => mixed.evaluate(element => element.scrollLeft)).toBeGreaterThan(0)
})
