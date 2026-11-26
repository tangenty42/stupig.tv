import { expect } from '@playwright/test'
import { ready, test } from '../support/e2e-browser'

test('the home page hydrates cleanly, follows the theme, and connects the archive and the contact page', async ({ page }) => {
  const mismatches: string[] = []
  page.on('console', (message) => {
    if (/hydration.*mismatch/i.test(message.text()))
      mismatches.push(message.text())
  })

  await page.goto('/')
  await ready(page)

  await test.step('hydration reports no mismatch, then the emoji keeps changing', async () => {
    const archive = page.getByRole('link', { name: /快查看『蠢猪档案』/ })
    const first = await archive.textContent()
    await expect.poll(() => archive.textContent()).not.toBe(first)
    expect(mismatches).toEqual([])
  })

  await test.step('the chant image is inverted only in dark mode', async () => {
    const chant = page.getByRole('img', { name: 'Stupig Chant', exact: true })
    const is_dark = () => page.evaluate(() => document.documentElement.classList.contains('dark'))
    const started_dark = await is_dark()
    await expect(chant).toHaveCSS('filter', started_dark ? 'invert(1)' : 'none')
    await page.getByRole('button', { name: '切换浅色 / 深色模式', exact: true }).click()
    await expect.poll(is_dark).toBe(! started_dark)
    await expect(chant).toHaveCSS('filter', started_dark ? 'none' : 'invert(1)')
  })

  await test.step('the archive entry leads to the archive list', async () => {
    await page.getByRole('link', { name: /快查看『蠢猪档案』/ }).click()
    await expect(page).toHaveURL(new URL('/content', page.url()).href)
    await expect(page.getByRole('heading', { level: 1 })).toContainText('蠢猪档案')
  })

  await test.step('the contact entry leads to the contact page, which leads back home', async () => {
    await page.goto('/')
    await ready(page)
    await page.getByRole('link', { name: /联系我们这帮『全能型人才』/ }).click()
    await expect(page).toHaveURL(new URL('/contact', page.url()).href)
    await expect(page).toHaveTitle('联系我们')
    await expect(page.locator('header').getByText('联系我们', { exact: true })).toBeVisible()
    await expect(page.getByRole('heading', { level: 1, name: '联系我们', exact: true })).toBeVisible()
    await page.getByRole('link', { name: '返回主页', exact: true }).click()
    await expect(page).toHaveURL(new URL('/', page.url()).href)
  })
})

test('public route content fades out then in while the header and main container remain stable', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await page.goto('/')
  await ready(page)
  await expect(page.locator('main > .site-page-enter-active')).toHaveCount(0)
  const capture = await page.evaluateHandle(() => {
    const main = document.querySelector('main')!
    const header = document.querySelector('header')!
    const state = {
      main,
      header,
      samples: [] as { phase: 'leave' | 'enter', duration: number, easing: string, opacity: number, keyframes: number[], page_root: boolean, main_opacity: string, header_opacity: string, contact_present: boolean }[],
      stop() {
        document.removeEventListener('transitionrun', observe, true)
      },
    }
    function observe(event: TransitionEvent) {
      const element = event.target
      if (event.propertyName !== 'opacity' || ! (element instanceof HTMLElement) || element.parentElement !== main)
        return
      const phase = element.classList.contains('site-page-leave-active') ? 'leave' : element.classList.contains('site-page-enter-active') ? 'enter' : null
      if (! phase)
        return
      const animation = element.getAnimations().find(animation => animation instanceof CSSTransition && animation.transitionProperty === 'opacity')!
      const duration = Number(animation.effect!.getComputedTiming().duration)
      const current_time = animation.currentTime
      animation.pause()
      animation.currentTime = duration / 2
      state.samples.push({
        phase,
        duration,
        easing: getComputedStyle(element).transitionTimingFunction,
        opacity: Number(getComputedStyle(element).opacity),
        keyframes: (animation.effect as KeyframeEffect).getKeyframes().map(frame => Number(frame.opacity)),
        page_root: element !== main && element !== header && ! element.contains(header),
        main_opacity: getComputedStyle(main).opacity,
        header_opacity: getComputedStyle(header).opacity,
        contact_present: !! main.querySelector('h1'),
      })
      // Vue also has a wall-clock timeout for transition completion. Sample in
      // this callback, then restore playback before that timeout can remove it.
      animation.currentTime = current_time
      animation.play()
    }
    document.addEventListener('transitionrun', observe, true)
    return state
  })

  try {
    await page.getByRole('link', { name: /联系我们这帮『全能型人才』/ }).click()
    await expect.poll(() => capture.evaluate(state => state.samples.map(sample => sample.phase))).toEqual(['leave', 'enter'])
    const leave = await capture.evaluate(state => state.samples[0]!)
    expect(leave).toMatchObject({ duration: 180, easing: 'ease-in', keyframes: [1, 0], page_root: true, main_opacity: '1', header_opacity: '1', contact_present: false })
    expect(leave.opacity).toBeGreaterThan(0)
    expect(leave.opacity).toBeLessThan(1)
    const enter = await capture.evaluate(state => state.samples[1]!)
    expect(enter).toMatchObject({ duration: 300, easing: 'ease-out', keyframes: [0, 1], page_root: true, main_opacity: '1', header_opacity: '1', contact_present: true })
    expect(enter.opacity).toBeGreaterThan(0)
    expect(enter.opacity).toBeLessThan(1)
    await expect(page.locator('main > .site-page-enter-active')).toHaveCount(0)
    await expect(page.getByRole('heading', { level: 1, name: '联系我们', exact: true })).toBeVisible()
    expect(await capture.evaluate(state => state.main === document.querySelector('main') && state.header === document.querySelector('header'))).toBe(true)
  }
  finally {
    await capture.evaluate(state => state.stop())
    await capture.dispose()
  }

  await page.goBack()
  await expect(page).toHaveURL(new URL('/', page.url()).href)
  await expect(page.getByRole('link', { name: /快查看『蠢猪档案』/ })).toBeVisible()
})

test('reduced motion presents the new page immediately and hash navigation preserves its root', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/')
  await ready(page)
  await expect(page.locator('main > .site-page-enter-active')).toHaveCount(0)
  const capture = await page.evaluateHandle(() => {
    const main = document.querySelector('main')!
    const state = { samples: [] as { opacity: string, duration: string }[], transitions: 0 }
    const observer = new MutationObserver(() => {
      for (const element of main.children) {
        if (element.classList.contains('site-page-enter-active') || element.classList.contains('site-page-leave-active')) {
          const style = getComputedStyle(element)
          state.samples.push({ opacity: style.opacity, duration: style.transitionDuration })
        }
      }
    })
    const transition = (event: TransitionEvent) => {
      if (event.propertyName === 'opacity' && event.target instanceof HTMLElement && event.target.parentElement === main)
        state.transitions ++
    }
    observer.observe(main, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] })
    main.addEventListener('transitionrun', transition)
    return {
      state,
      stop() {
        observer.disconnect()
        main.removeEventListener('transitionrun', transition)
      },
    }
  })

  try {
    await page.getByRole('link', { name: /联系我们这帮『全能型人才』/ }).click()
    await expect(page.getByRole('heading', { level: 1, name: '联系我们', exact: true })).toBeVisible()
    await expect(page.locator('main > .site-page-enter-active')).toHaveCount(0)
    const result = await capture.evaluate(({ state }) => state)
    expect(result.samples.length).toBeGreaterThan(0)
    expect(result.samples.every(sample => sample.opacity === '1' && sample.duration === '0s')).toBe(true)
    expect(result.transitions).toBe(0)

    const contact = await page.locator('main > *').elementHandle()
    await page.goto(new URL('/contact#contact-details', page.url()).href)
    expect(await contact!.evaluate(element => element.isConnected && element === document.querySelector('main')!.firstElementChild)).toBe(true)
    expect(await capture.evaluate(({ state }) => state.samples.length)).toBe(result.samples.length)
    await contact!.dispose()
  }
  finally {
    await capture.evaluate(state => state.stop())
    await capture.dispose()
  }
})
