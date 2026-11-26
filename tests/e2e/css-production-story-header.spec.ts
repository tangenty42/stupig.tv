import { expect } from '@playwright/test'
import sharp from 'sharp'
import { create_story, login, markdown, ready, test } from '../support/e2e-browser'

type CoverDecodeWindow = Window & { __COVER_DECODE__?: { native_ready: boolean, completed: boolean, release: () => void } }

test('a direct list cover waits for decoding and paints blended pixels through its reveal', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await page.addInitScript(() => {
    const gate = Promise.withResolvers<void>()
    const state = { native_ready: false, completed: false, release: () => gate.resolve() }
    const target = window as CoverDecodeWindow
    target.__COVER_DECODE__ = state
    const decode = HTMLImageElement.prototype.decode
    HTMLImageElement.prototype.decode = async function () {
      if (! this.src.includes('name=lqip-cover'))
        return decode.call(this)
      await decode.call(this)
      state.native_ready = true
      await gate.promise
      state.completed = true
    }
  })
  const cover = Promise.withResolvers<void>()
  const png = await sharp({ create: { width: 800, height: 320, channels: 3, background: '#165bc4' } }).png().toBuffer()
  await page.route('**/api/e2e-css-image?name=lqip-cover', async (route) => {
    await cover.promise
    await route.fulfill({ contentType: 'image/png', body: png })
  })
  try {
    await page.goto('/markdown-layout?loading=1')
    await ready(page)
    const frame = page.locator('.story-card-cover .img-frame')
    const image = frame.locator('img')
    const layer = frame.locator('.image-lqip')
    cover.resolve()
    await page.waitForFunction(() => (window as CoverDecodeWindow).__COVER_DECODE__?.native_ready)
    const pending = await frame.evaluate(async (element) => {
      const layer = element.querySelector('.image-lqip')!
      const breathing = layer.getAnimations({ subtree: true }).find(animation => animation instanceof CSSAnimation && animation.animationName === 'image-placeholder-breathe')!
      await new Promise<void>((resolve) => {
        layer.addEventListener('animationiteration', () => resolve(), { once: true })
        breathing.currentTime = 2180
        breathing.play()
      })
      breathing.pause()
      breathing.currentTime = 0
      return { loaded: element.hasAttribute('data-image-loaded'), busy: element.getAttribute('aria-busy'), opacity: getComputedStyle(layer).opacity }
    })
    expect(pending).toEqual({ loaded: false, busy: 'true', opacity: '1' })
    expect(await page.evaluate(() => (window as CoverDecodeWindow).__COVER_DECODE__?.completed)).toBe(false)
    const pixel = async () => [... await sharp(await frame.screenshot({ animations: 'allow' }))
      .extract({ left: 48, top: 48, width: 1, height: 1 }).removeAlpha().raw().toBuffer()]
    const opaque = await pixel()

    await page.evaluate(() => (window as CoverDecodeWindow).__COVER_DECODE__?.release())
    await expect(image).toHaveCSS('opacity', '1')
    await expect(layer).toHaveCSS('opacity', '1')
    await expect(frame).toHaveAttribute('aria-busy', 'true')
    expect(await pixel()).toEqual(opaque)
    await frame.evaluate((element) => {
      const observer = new MutationObserver(() => {
        if (! element.hasAttribute('data-image-loaded'))
          return
        observer.disconnect()
        void getComputedStyle(element.querySelector('.image-lqip')!).opacity
        for (const animation of element.getAnimations({ subtree: true })) {
          if (animation instanceof CSSTransition && animation.transitionProperty === 'opacity') {
            animation.pause()
            animation.currentTime = 0
          }
        }
        element.setAttribute('data-test-fade-paused', '')
      })
      observer.observe(element, { attributes: true, attributeFilter: ['data-image-loaded'] })
      const breathing = element.querySelector('.image-lqip')!.getAnimations({ subtree: true }).find(animation => animation instanceof CSSAnimation && animation.animationName === 'image-placeholder-breathe')!
      breathing.currentTime = 2180
      breathing.play()
    })
    await expect(frame).toHaveAttribute('data-test-fade-paused', '')
    const pixels: number[][] = []
    for (const time of [0, 700, 1400]) {
      await frame.evaluate((element, time) => {
        for (const animation of element.getAnimations({ subtree: true })) {
          if (animation instanceof CSSTransition && animation.transitionProperty === 'opacity')
            animation.currentTime = time
        }
      }, time)
      pixels.push(await pixel())
    }
    const [start, middle, end] = pixels as [number[], number[], number[]]
    for (const [channel, value] of [22, 91, 196].entries())
      expect(Math.abs(end[channel]! - value)).toBeLessThan(5)
    expect(start.reduce((distance, value, channel) => distance + Math.abs(value - end[channel]!), 0)).toBeGreaterThan(30)
    for (const [channel, value] of middle.entries())
      expect(Math.abs(value - (start[channel]! + end[channel]!) / 2)).toBeLessThan(5)
  }
  finally {
    cover.resolve()
    await page.evaluate(() => (window as CoverDecodeWindow).__COVER_DECODE__?.release())
  }
})

test('SSR list cover hydration preserves the image, LQIP layer and active breathing animation', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  const scripts = Promise.withResolvers<void>()
  const cover = Promise.withResolvers<void>()
  await page.route('**/_nuxt/*.js', async (route) => {
    await scripts.promise
    await route.continue()
  })
  await page.route('**/api/e2e-css-image?name=lqip-cover', async (route) => {
    await cover.promise
    await route.continue()
  })
  try {
    await page.goto('/markdown-layout?loading=1', { waitUntil: 'commit' })
    const frame = page.locator('.story-card-cover .img-frame')
    await expect(frame).toHaveAttribute('aria-busy', 'true')
    await expect(frame.locator('.image-lqip')).toHaveCount(1)
    await expect.poll(() => frame.evaluate(element => getComputedStyle(element.querySelector('.image-lqip')!, '::before').animationName)).toBe('image-placeholder-breathe')
    const ssr = await frame.evaluateHandle((element) => {
      const image = element.querySelector('img')!
      const layer = element.querySelector('.image-lqip')!
      const animation = layer.getAnimations({ subtree: true }).find(animation => animation instanceof CSSAnimation && animation.animationName === 'image-placeholder-breathe')!
      return { element, image, layer, animation, time: Number(animation.currentTime) }
    })
    try {
      scripts.resolve()
      await ready(page)
      const hydrated = await ssr.evaluate((before) => {
        const current = document.querySelector('.story-card-cover .img-frame')!
        const layer = current.querySelector('.image-lqip')!
        const animation = layer.getAnimations({ subtree: true }).find(animation => animation instanceof CSSAnimation && animation.animationName === 'image-placeholder-breathe')!
        return {
          same_frame: before.element === current,
          same_image: before.image === current.querySelector('img'),
          same_layer: before.layer === layer,
          same_animation: before.animation === animation,
          previous_connected: before.image.isConnected && before.layer.isConnected,
          continued: Number(animation.currentTime) >= before.time,
        }
      })
      expect(hydrated).toEqual({ same_frame: true, same_image: true, same_layer: true, same_animation: true, previous_connected: true, continued: true })
      cover.resolve()
      await expect(frame).toHaveAttribute('data-image-loaded', '')
      await expect.poll(() => frame.getAttribute('aria-busy')).toBeNull()
      expect(await ssr.evaluate(before => before.element === document.querySelector('.story-card-cover .img-frame'))).toBe(true)
    }
    finally {
      await ssr.dispose()
    }
  }
  finally {
    scripts.resolve()
    cover.resolve()
  }
})

test('the rated story banner stays full width from SSR through hydration and late cover loading', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 })
  await login(page)
  const { id, title } = await create_story(page)
  const cover_url = new URL('/api/e2e-css-image', page.url()).href
  const body = markdown(title, 'A story with a delayed cover').replace('label:', `cover: ![cover](${cover_url})\nlabel:`)
  await page.getByRole('textbox', { name: '档案内容 Markdown 编辑器' }).fill(body)
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect(page.getByText('档案已保存', { exact: true })).toBeVisible()

  const scripts = Promise.withResolvers<void>()
  const cover = Promise.withResolvers<void>()
  await page.route('**/_nuxt/*.js', async (route) => {
    await scripts.promise
    await route.continue()
  })
  await page.route(cover_url, async (route) => {
    await cover.promise
    await route.continue()
  })
  try {
    await page.goto(`/content/${id}`, { waitUntil: 'commit' })
    const band = page.locator('.story-header-band')
    await expect(band.getByRole('heading', { name: title })).toBeVisible()
    await expect(band.locator('img[hidden]')).toHaveAttribute('src', /\/imgs\/ratings\/\d\.svg$/)
    await expect(band.locator('.story-watermark-image')).toHaveCount(0)
    const finish = await band.evaluateHandle((ssr) => {
      let failure = ''
      let frame = 0
      function sample() {
        if (! ssr.isConnected)
          failure ||= 'The server-rendered banner was removed'
        for (let node: Element | null = ssr; node; node = node.parentElement) {
          if (Number(getComputedStyle(node).opacity) === 0)
            failure ||= 'The banner became transparent'
        }
        const y = ssr.getBoundingClientRect().top + 4
        for (const x of [2, document.documentElement.clientWidth - 3]) {
          // The initial mask covers the whole page. Hit-test the stack behind
          // it so an ancestor clipping the actual painted band is observable.
          if (! document.elementsFromPoint(x, y).some(hit => ssr.contains(hit)))
            failure ||= `Banner is clipped at x=${x}, y=${y}`
        }
        frame = requestAnimationFrame(sample)
      }
      sample()
      return () => {
        cancelAnimationFrame(frame)
        return failure
      }
    })
    scripts.resolve()
    await ready(page)
    await expect(band.locator('.story-watermark-image')).toHaveCSS('background-image', /\/imgs\/ratings\/\d\.svg/)
    const height_before_cover = await band.evaluate(element => element.getBoundingClientRect().height)
    cover.resolve()
    await band.locator('.story-cover-button img').evaluate((image: HTMLImageElement) => image.decode())
    await band.evaluate(async (element) => {
      // ResizeObserver and the ensuing height transition start after layout.
      await new Promise(requestAnimationFrame)
      await new Promise(requestAnimationFrame)
      const animations = element.closest('section')!.getAnimations({ subtree: true })
      await Promise.all(animations.filter(animation => animation instanceof CSSTransition && animation.transitionProperty === 'height')
        .map(animation => animation.finished.catch(() => {})))
    })
    expect(await band.evaluate(element => element.getBoundingClientRect().height)).toBeGreaterThan(height_before_cover + 1)
    expect(await finish.evaluate(stop => stop())).toBe('')
  }
  finally {
    scripts.resolve()
    cover.resolve()
  }
})
