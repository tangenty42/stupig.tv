import { expect } from '@playwright/test'
import sharp from 'sharp'
import { create_story, login, markdown, ready, test } from '../support/e2e-browser'

test('finishes the LQIP breath before crossfading to the ready image', async ({ page }) => {
  await login(page)
  const { id, title } = await create_story(page)
  const pixels = { create: { width: 160, height: 120, channels: 3 as const, background: '#c34444' } }
  const image = await sharp(pixels).png().toBuffer()
  const lqip = (await sharp(pixels).jpeg().toBuffer()).toString('base64')
  let release_image!: () => void
  const loading = new Promise<void>(resolve => release_image = resolve)
  let release_error!: () => void
  const failing = new Promise<void>(resolve => release_error = resolve)
  await page.route('https://image.test/slow.png', async (route) => {
    await loading
    await route.fulfill({ status: 200, contentType: 'image/png', body: image })
  })
  await page.route('https://image.test/missing.png', async (route) => {
    await failing
    await route.fulfill({ status: 404 })
  })

  await page.goto(`/content/${id}/edit`)
  await ready(page)
  await page.getByRole('textbox', { name: '档案内容 Markdown 编辑器', exact: true }).fill(markdown(title, '![slow](https://image.test/slow.png)\n\n![missing](https://image.test/missing.png)'))
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
    frame.querySelector('img')!.insertAdjacentHTML('afterend', '<span class="image-lqip" aria-hidden="true"></span>')
  }, lqip)
  const motion = await frame.evaluate((element) => {
    const icon = element.querySelector('.image-loading-mask .iconify')!
    const layer = element.querySelector('.image-lqip')!
    const placeholder = element.getAnimations({ subtree: true }).find(animation => animation instanceof CSSAnimation && animation.animationName === 'image-placeholder-breathe')!
    const spinner = icon.getAnimations().find(animation => animation instanceof CSSAnimation && animation.animationName === 'image-loading-spin')!
    placeholder.pause()
    spinner.pause()
    placeholder.currentTime = 0
    spinner.currentTime = 0
    const dim = getComputedStyle(layer, '::before').filter
    const start = getComputedStyle(icon).transform
    placeholder.currentTime = 1100
    spinner.currentTime = 250
    const bright = getComputedStyle(layer, '::before').filter
    const quarter_turn = getComputedStyle(icon).transform
    spinner.play()
    return { dim, bright, start, quarter_turn }
  })
  expect(motion.dim).toContain('opacity(0.35)')
  expect(motion.bright).toContain('opacity(1)')
  expect(motion.quarter_turn).not.toBe(motion.start)
  await frame.evaluate(async (element) => {
    void getComputedStyle(element.querySelector('img')!).opacity
    await new Promise(requestAnimationFrame)
  })
  await frame.evaluate((element) => {
    const layer = element.querySelector('.image-lqip')!
    layer.addEventListener('animationiteration', () => element.setAttribute('data-test-breath-finished', ''), { once: true })
    element.querySelector('img')!.addEventListener('load', () => {
      element.setAttribute('data-test-ready-before-reveal', String(! element.hasAttribute('data-image-loaded')))
      const breathing = element.getAnimations({ subtree: true }).find(animation => animation instanceof CSSAnimation && animation.animationName === 'image-placeholder-breathe')!
      breathing.currentTime = 2180
      breathing.play()
    }, { once: true })
    const observer = new MutationObserver(() => {
      if (! element.hasAttribute('data-image-loaded'))
        return
      observer.disconnect()
      void getComputedStyle(element.querySelector('img')!).opacity
      for (const animation of element.getAnimations({ subtree: true })) {
        if (animation instanceof CSSAnimation && animation.animationName === 'image-placeholder-breathe')
          continue
        animation.pause()
        animation.currentTime = 700
      }
      element.setAttribute('data-test-paused', '')
    })
    observer.observe(element, { attributes: true, attributeFilter: ['data-image-loaded'] })
  })
  release_image()
  await expect(frame).toHaveAttribute('data-test-ready-before-reveal', 'true')
  await expect(frame).toHaveAttribute('data-test-breath-finished', '')
  await expect(frame).toHaveAttribute('data-test-paused', '')

  const transition = await frame.evaluate((element) => {
    const image = element.querySelector('img')!
    const layer = element.querySelector('.image-lqip')!
    const mask = element.querySelector('.image-loading-mask')!
    const rect = image.getBoundingClientRect()
    const fade = layer.getAnimations().find(animation => animation instanceof CSSTransition && animation.transitionProperty === 'opacity')!
    fade.currentTime = 225
    const early_reveal = 1 - Number(getComputedStyle(layer).opacity)
    fade.currentTime = 700
    const filter = getComputedStyle(layer, '::before').filter
    const result = {
      early_reveal,
      image_opacity: Number(getComputedStyle(image).opacity),
      layer_opacity: Number(getComputedStyle(layer).opacity),
      breath_opacity: Number(filter.match(/opacity\(([^)]+)\)/)?.[1]),
      mask_opacity: Number(getComputedStyle(mask).opacity),
      image_receives_click: document.elementFromPoint(rect.left + 10, rect.top + 10) === image,
    }
    // For the pixel regression, make both input layers the same color.
    const breathing = element.getAnimations({ subtree: true }).find(animation => animation instanceof CSSAnimation && animation.animationName === 'image-placeholder-breathe')!
    breathing.currentTime = 1100
    return result
  })
  expect(transition.early_reveal).toBeGreaterThan(0)
  expect(transition.early_reveal).toBeLessThan(0.1)
  expect(transition.image_opacity).toBe(1)
  expect(transition.layer_opacity).toBeCloseTo(0.5)
  expect(transition.breath_opacity).toBeLessThan(0.4)
  expect(transition.mask_opacity).toBeCloseTo(0.5)
  expect(transition.image_receives_click).toBe(true)
  // At its peak, a same-colored placeholder and image should never expose a third color.
  const pixel = await sharp(await frame.screenshot())
    .extract({ left: 24, top: 24, width: 1, height: 1 }).removeAlpha().raw().toBuffer()
  for (const [channel, color] of [195, 68, 68].entries())
    expect(Math.abs(pixel[channel]! - color)).toBeLessThan(5)

  const cover = await page.evaluate(async ({ lqip, png }) => {
    const frame = document.createElement('span')
    frame.className = 'img-frame content-cover'
    frame.dataset.lqip = ''
    frame.style.setProperty('--content-lqip', `url(data:image/jpeg;base64,${lqip})`)
    frame.innerHTML = `<img src="data:image/png;base64,${png}" alt="cover"><span class="image-lqip" aria-hidden="true"></span><span class="image-loading-mask"><span class="iconify"></span></span><span class="image-unavailable">unavailable</span>`
    document.body.append(frame)
    const mask = frame.querySelector<HTMLElement>('.image-loading-mask')!
    const image = frame.querySelector('img')!
    const layer = frame.querySelector('.image-lqip')!
    await image.decode()
    const breathing = getComputedStyle(layer, '::before').animationName
    const spinning = getComputedStyle(mask.querySelector('.iconify')!).animationName
    const placeholder = frame.getAnimations({ subtree: true }).find(animation => animation instanceof CSSAnimation && animation.animationName === breathing)!
    placeholder.pause()
    placeholder.currentTime = 0
    await new Promise(requestAnimationFrame)
    frame.dataset.imageLoaded = ''
    await new Promise(requestAnimationFrame)
    for (const animation of frame.getAnimations({ subtree: true })) {
      if (animation === placeholder)
        continue
      animation.pause()
      animation.currentTime = 700
    }
    return {
      breathing,
      spinning,
      image_opacity: Number(getComputedStyle(image).opacity),
      layer_opacity: Number(getComputedStyle(layer).opacity),
      placeholder_filter: getComputedStyle(layer, '::before').filter,
      mask_opacity: Number(getComputedStyle(mask).opacity),
    }
  }, { lqip, png: image.toString('base64') })
  expect(cover.breathing).toBe('image-placeholder-breathe')
  expect(cover.spinning).toBe('image-loading-spin')
  expect(cover.image_opacity).toBe(1)
  expect(cover.layer_opacity).toBeCloseTo(0.5)
  expect(cover.placeholder_filter).toContain('opacity(0.35)')
  expect(cover.mask_opacity).toBeGreaterThan(0)
  expect(cover.mask_opacity).toBeLessThan(1)

  const missing = page.locator('.story-body .img-frame').nth(1)
  await expect(missing).toHaveAttribute('aria-busy', 'true')
  await expect(missing).not.toHaveAttribute('data-lqip')
  const initial_width = await missing.evaluate(element => element.getBoundingClientRect().width)
  await missing.evaluate((element) => {
    const observer = new MutationObserver(() => {
      if (! element.hasAttribute('data-image-error'))
        return
      observer.disconnect()
      for (const animation of element.getAnimations({ subtree: true })) {
        animation.pause()
        animation.currentTime = 225
      }
      element.setAttribute('data-test-paused', '')
    })
    observer.observe(element, { attributes: true, attributeFilter: ['data-image-error'] })
  })
  release_error()
  await expect(missing).toHaveAttribute('data-test-paused', '')
  const failure = await missing.evaluate(element => ({
    mask: Number(getComputedStyle(element.querySelector('.image-loading-mask')!).opacity),
    notice: Number(getComputedStyle(element.querySelector('.image-unavailable')!).opacity),
    width: element.getBoundingClientRect().width,
  }))
  expect(failure.mask).toBeGreaterThan(0)
  expect(failure.mask).toBeLessThan(1)
  expect(failure.notice).toBeGreaterThan(0)
  expect(failure.notice).toBeLessThan(1)
  expect(failure.width).toBeGreaterThan(initial_width)
  expect(failure.width).toBeLessThan(256)

  await page.emulateMedia({ reducedMotion: 'reduce' })
  const layer = frame.locator('.image-lqip')
  await expect.poll(() => layer.evaluate(element => getComputedStyle(element).transitionDuration)).toBe('0s')
  await expect.poll(() => layer.evaluate(element => getComputedStyle(element, '::before').animationName)).toBe('none')
  await expect.poll(() => layer.evaluate(element => getComputedStyle(element).opacity)).toBe('0')
  await expect.poll(() => page.locator('body > .content-cover .image-lqip').evaluate(element => getComputedStyle(element).transitionDuration)).toBe('0s')
  await expect.poll(() => frame.locator('.image-loading-mask .iconify').evaluate(element => getComputedStyle(element).animationName)).toBe('none')
  await expect.poll(() => page.locator('body > .content-cover .iconify').evaluate(element => getComputedStyle(element).animationName)).toBe('none')

  for (const item of [frame, page.locator('body > .content-cover')]) {
    await item.evaluate((element) => {
      element.removeAttribute('data-image-loaded')
      element.setAttribute('data-image-error', '')
    })
    await expect(item.locator('img')).toBeHidden()
    await expect(item.locator('.image-unavailable')).toBeVisible()
    await expect(item.locator('.image-loading-mask')).toBeHidden()
  }
})
