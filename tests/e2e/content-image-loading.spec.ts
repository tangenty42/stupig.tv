import { expect } from '@playwright/test'
import sharp from 'sharp'
import { create_story, login, markdown, ready, test } from '../support/e2e-browser'

test('image placeholders breathe and stay behind the image during its fade', async ({ page }) => {
  await login(page)
  const { id, title } = await create_story(page)
  const pixels = { create: { width: 160, height: 120, channels: 3 as const, background: '#c34444' } }
  const image = await sharp(pixels).png().toBuffer()
  const lqip = (await sharp(pixels).jpeg().toBuffer()).toString('base64')
  let release_image!: () => void
  const loading = new Promise<void>(resolve => release_image = resolve)
  await page.route('https://image.test/slow.png', async (route) => {
    await loading
    await route.fulfill({ status: 200, contentType: 'image/png', body: image })
  })

  await page.goto(`/content/${id}/edit`)
  await ready(page)
  await page.getByRole('textbox', { name: '档案内容 Markdown 编辑器', exact: true }).fill(markdown(title, '![slow](https://image.test/slow.png)'))
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect(page.getByText('档案已保存', { exact: true })).toBeVisible()
  await page.goto(`/content/${id}`, { waitUntil: 'domcontentloaded' })
  await ready(page)
  const frame = page.locator('.story-body .img-frame').first()
  await expect(frame.locator('img')).toHaveAttribute('src', 'https://image.test/slow.png')
  await frame.evaluate((element, data) => {
    element.setAttribute('data-lqip', '')
    const frame = element as HTMLElement
    frame.style.setProperty('--content-lqip', `url(data:image/jpeg;base64,${data})`)
  }, lqip)
  await expect.poll(() => frame.locator('.image-loading-mask .iconify').evaluate(element => getComputedStyle(element).animationName)).toBe('image-loading-breathe')
  await frame.evaluate((element) => {
    const observer = new MutationObserver(() => {
      if (! element.hasAttribute('data-image-loaded'))
        return
      observer.disconnect()
      void getComputedStyle(element.querySelector('img')!).opacity
      requestAnimationFrame(() => {
        for (const animation of element.getAnimations({ subtree: true })) {
          animation.pause()
          animation.currentTime = 225
        }
        element.setAttribute('data-test-paused', '')
      })
    })
    observer.observe(element, { attributes: true, attributeFilter: ['data-image-loaded'] })
  })
  release_image()
  await expect(frame).toHaveAttribute('data-test-paused', '')

  const transition = await frame.evaluate((element) => {
    const image = element.querySelector('img')!
    const mask = element.querySelector('.image-loading-mask')!
    const rect = image.getBoundingClientRect()
    return {
      image_opacity: Number(getComputedStyle(image).opacity),
      placeholder_opacity: Number(getComputedStyle(element, '::before').opacity),
      mask_opacity: Number(getComputedStyle(mask).opacity),
      image_on_top: document.elementFromPoint(rect.left + 10, rect.top + 10) === image,
    }
  })
  expect(transition.image_opacity).toBeGreaterThan(0)
  expect(transition.image_opacity).toBeLessThan(1)
  expect(transition.placeholder_opacity).toBe(1)
  expect(transition.mask_opacity).toBeGreaterThan(0)
  expect(transition.mask_opacity).toBeLessThan(1)
  expect(transition.image_on_top).toBe(true)

  const cover = await page.evaluate(async ({ lqip, png }) => {
    const frame = document.createElement('span')
    frame.className = 'content-cover'
    frame.dataset.lqip = ''
    frame.style.setProperty('--content-lqip', `url(data:image/jpeg;base64,${lqip})`)
    frame.innerHTML = `<img src="data:image/png;base64,${png}" alt="cover"><span class="image-loading-mask"><span class="iconify"></span></span>`
    document.body.append(frame)
    const mask = frame.querySelector<HTMLElement>('.image-loading-mask')!
    const image = frame.querySelector('img')!
    await image.decode()
    const breathing = getComputedStyle(mask.querySelector('.iconify')!).animationName
    await new Promise(requestAnimationFrame)
    frame.dataset.imageLoaded = ''
    await new Promise(requestAnimationFrame)
    for (const animation of frame.getAnimations({ subtree: true })) {
      animation.pause()
      animation.currentTime = 225
    }
    return {
      breathing,
      image_opacity: Number(getComputedStyle(image).opacity),
      placeholder_opacity: Number(getComputedStyle(frame, '::before').opacity),
      mask_opacity: Number(getComputedStyle(mask).opacity),
    }
  }, { lqip, png: image.toString('base64') })
  expect(cover.breathing).toBe('image-loading-breathe')
  expect(cover.image_opacity).toBeGreaterThan(0)
  expect(cover.image_opacity).toBeLessThan(1)
  expect(cover.placeholder_opacity).toBe(1)
  expect(cover.mask_opacity).toBeGreaterThan(0)
  expect(cover.mask_opacity).toBeLessThan(1)

  await page.emulateMedia({ reducedMotion: 'reduce' })
  await expect.poll(() => frame.evaluate(element => getComputedStyle(element, '::before').transitionDuration)).toBe('0s')
  await expect.poll(() => page.locator('body > .content-cover').evaluate(element => getComputedStyle(element, '::before').transitionDuration)).toBe('0s')
  await expect.poll(() => frame.locator('.image-loading-mask .iconify').evaluate(element => getComputedStyle(element).animationName)).toBe('none')
  await expect.poll(() => page.locator('body > .content-cover .iconify').evaluate(element => getComputedStyle(element).animationName)).toBe('none')
})
