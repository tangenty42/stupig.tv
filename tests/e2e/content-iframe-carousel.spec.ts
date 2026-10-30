import { expect } from '@playwright/test'
import { login, markdown, ready, test } from '../support/e2e-browser'

test('renders an iframe alongside an image and warns when it is used as a link', async ({ page }) => {
  let release_player!: () => void
  const loading = new Promise<void>(resolve => release_player = resolve)
  await page.route('https://player.bilibili.com/player.html*', async (route) => {
    await loading
    await route.fulfill({ contentType: 'text/html', body: '<html><body>Player ready</body></html>' })
  })
  await login(page)
  await page.goto('/content/new/edit')
  await ready(page)
  const editor = page.getByRole('textbox', { name: '档案内容 Markdown 编辑器', exact: true })
  await expect(editor).toBeEditable()
  await page.getByRole('button', { name: '全屏编辑' }).click()
  await expect(page.getByRole('button', { name: '退出全屏' })).toBeVisible()
  const target = 'iframe://player.bilibili.com/player.html?bvid=BV1Pvnd6JEVD'
  await editor.fill(markdown('E2E iframe', `![图片](https://example.com/image.png)\n![视频](${target})\n\n[错误链接](${target})`))
  const carousel = page.locator('.story-body .image-carousel')
  await expect(carousel.locator('.carousel-item')).toHaveCount(2)
  await expect(carousel.locator('.carousel-item iframe')).toHaveAttribute('src', 'https://player.bilibili.com/player.html?bvid=BV1Pvnd6JEVD')
  await expect(carousel.locator('.carousel-caption').last()).toHaveText('视频')
  await expect(page.getByText('iframe:// 只能用于图片语法 ![标题](iframe://...)')).toBeVisible()
  const frame = carousel.locator('.iframe-frame')
  await expect(frame).toHaveAttribute('aria-busy', 'true')
  await expect(frame.locator('.image-loading-mask')).toBeVisible()
  await expect(frame.locator('.image-loading-mask .iconify')).toHaveCSS('animation-name', 'image-loading-spin')
  expect(await frame.evaluate(element => getComputedStyle(element, '::before').animationName)).toBe('image-placeholder-breathe')
  const ratio = await frame.locator('iframe').evaluate((element) => {
    const rect = element.getBoundingClientRect()
    return rect.width / rect.height
  })
  expect(ratio).toBeCloseTo(16 / 9, 1)
  release_player()
  await expect(frame).toHaveAttribute('data-image-loaded', '')
  await expect(frame.locator('.image-loading-mask')).toBeHidden()
  await expect(frame.locator('iframe')).toHaveCSS('opacity', '1')
})
