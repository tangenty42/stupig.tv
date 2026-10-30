import { expect } from '@playwright/test'

interface MediaBrowser {
  execute: (script: string) => Promise<any>
  click: (selector: string) => Promise<void>
  capture?: (name: string) => Promise<void>
}

// Use the same DOM observations and native button interactions in modern
// Playwright and historical W3C WebDriver sessions. No app internals are read.
export async function check_css_media(browser: MediaBrowser) {
  await expect.poll(() => browser.execute(`return document.querySelector('[data-testid="media-ready"]')?.textContent === 'client' && !!window.__STUPIG_E2E_READY__?.() && !document.querySelector('#app-loading-mask')`)).toBe(true)
  const state = () => browser.execute(`
    var root = document.querySelector('[data-testid="media-preview"]');
    var carousel = root.querySelector('.image-carousel');
    var shell = carousel.closest('.carousel-shell');
    var items = carousel.querySelectorAll('.carousel-item');
    var style = getComputedStyle(carousel);
    var caption = root.querySelector('.carousel-caption');
    var icon = getComputedStyle(shell.querySelector('.carousel-prev .iconify'));
    return {
      left: carousel.scrollLeft, max: carousel.scrollWidth - carousel.clientWidth,
      fadeL: parseFloat(style.getPropertyValue('--carousel-fade-l')),
      fadeR: parseFloat(style.getPropertyValue('--carousel-fade-r')),
      mask: style.maskImage || style.webkitMaskImage,
      prev: shell.querySelector('.carousel-prev').dataset.on,
      next: shell.querySelector('.carousel-next').dataset.on,
      hint: shell.querySelector('.carousel-next').dataset.hint || null,
      gap: items[1].getBoundingClientRect().left - items[0].getBoundingClientRect().right,
      overflow: carousel.getBoundingClientRect().right > root.getBoundingClientRect().right + 1,
      loaded: root.querySelectorAll('.img-frame[data-image-loaded]').length,
      captionColor: getComputedStyle(caption).color,
      iconMask: icon.maskImage || icon.webkitMaskImage,
      iconWidth: parseFloat(icon.width),
      dark: document.documentElement.classList.contains('dark')
    }`)
  await expect.poll(async () => (await state()).loaded).toBe(3)
  await expect.poll(async () => (await state()).fadeR).toBe(48)
  const initial = await state()
  expect(initial.max).toBeGreaterThan(0)
  expect(initial.fadeL).toBe(0)
  expect(initial.mask).toContain('linear-gradient')
  expect(initial.iconMask).toContain('url(')
  expect(initial.iconWidth).toBeGreaterThan(0)
  expect(initial.gap).toBeCloseTo(12, 0)
  expect(initial.hint).toBe('true')
  expect(initial.overflow).toBe(false)
  await browser.capture?.('media-initial')
  await browser.execute(`window.__MEDIA_SAMPLES__ = []; var carousel = document.querySelector('.image-carousel'); var start = performance.now(); function sample() { var value = parseFloat(getComputedStyle(carousel).getPropertyValue('--carousel-fade-l')); window.__MEDIA_SAMPLES__.push(value); if (performance.now() - start < 1600) requestAnimationFrame(sample) } requestAnimationFrame(sample)`)
  await browser.click('.carousel-next')
  await expect.poll(async () => (await state()).fadeL).toBe(48)
  expect((await state()).hint).toBeNull()
  const samples: number[] = await browser.execute('return window.__MEDIA_SAMPLES__')
  expect(samples.some(value => value > 0 && value < 48), 'Edge fade must interpolate in the actual engine').toBe(true)
  // Reach the end with native clicks, then verify the right fade animates out.
  for (let attempt = 0; attempt < 5 && (await state()).next === 'true'; attempt ++) {
    const before = (await state()).left
    await browser.click('.carousel-next')
    let previous = before
    await expect.poll(async () => {
      const current = (await state()).left
      const settled = current > before && Math.abs(current - previous) < 0.5
      previous = current
      return settled
    }).toBe(true)
    await expect.poll(async () => (await state()).fadeR).toBe((await state()).next === 'true' ? 48 : 0)
  }
  await expect.poll(async () => (await state()).next).toBe('false')
  await expect.poll(async () => (await state()).fadeR).toBe(0)
  const at_end = await state()
  await browser.click('[data-testid="media-edit"]')
  await expect.poll(async () => (await state()).left).toBeCloseTo(at_end.left, 0)
  await browser.click('[data-testid="media-remount"]')
  await expect.poll(async () => (await state()).left).toBeCloseTo(at_end.left, 0)
  expect((await state()).hint).toBeNull()
  await browser.click('[data-testid="media-theme"]')
  await expect.poll(async () => (await state()).dark).toBe(! initial.dark)
  await expect.poll(async () => (await state()).captionColor).not.toBe(initial.captionColor)
  await browser.click('[data-testid="media-narrow"]')
  await expect.poll(async () => (await state()).overflow).toBe(false)
  expect((await state()).gap).toBeCloseTo(12, 0)
  await browser.click('[data-testid="media-load"]')
  const pending = () => browser.execute(`var image = document.querySelector('img[src*="name=loading"]'); var frame = image?.parentElement; return frame ? {busy:frame.getAttribute('aria-busy'),width:frame.getBoundingClientRect().width,height:frame.getBoundingClientRect().height,loaded:frame.hasAttribute('data-image-loaded'),mask:getComputedStyle(frame.querySelector('.image-loading-mask')).visibility,spin:getComputedStyle(frame.querySelector('.image-loading-mask .iconify')).animationName,img:getComputedStyle(image).opacity} : null`)
  await expect.poll(async () => (await pending())?.busy).toBe('true')
  const loading = await pending()
  expect(loading.width).toBeGreaterThan(100)
  expect(loading.height).toBeGreaterThan(100)
  expect(loading.mask).toBe('visible')
  expect(loading.spin).toBe('image-loading-spin')
  expect(loading.img).toBe('0')
  await expect.poll(async () => (await pending())?.img).toBe('1')
  await expect.poll(async () => (await pending())?.mask).toBe('hidden')
  await expect.poll(() => browser.execute(`var frame = document.querySelector('img[src*="name=failed"]')?.parentElement; return !!frame?.hasAttribute('data-image-error') && getComputedStyle(frame.querySelector('.image-unavailable')).display === 'flex' && getComputedStyle(frame.querySelector('img')).display === 'none'`)).toBe(true)
  const failed = await browser.execute(`var box = document.querySelector('img[src*="name=failed"]').parentElement.querySelector('.image-unavailable').getBoundingClientRect(); return {width:box.width,height:box.height}`)
  expect(failed.width / failed.height).toBeCloseTo(16 / 9, 1)
  const loaded = await pending()
  expect(loaded.width).toBeCloseTo(loading.width, 0)
  expect(loaded.height).toBeCloseTo(loading.height, 0)
  await browser.capture?.('media-narrow-loaded')
  await browser.click('[data-testid="media-public"]')
  await expect.poll(() => browser.execute('return document.querySelectorAll(".encrypted-image-denied").length')).toBe(5)
  expect(await browser.execute('return document.querySelectorAll(".story-body img, .story-body .image-loading-mask").length')).toBe(0)
  return { initial, at_end, loading, loaded, failed, samples, final: await state() }
}
