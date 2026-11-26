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
  await expect(mixed.locator(':scope > :not(.carousel-space)')).toHaveCount(9)
  await expect(mixed.locator('.carousel-caption')).toHaveText(['Public caption', 'Private caption', 'Denied caption', 'Redacted caption', 'Player caption'])
  await expect(mixed.locator('.carousel-caption strong')).toHaveText('caption')
  await expect(mixed.locator('.story-card-desc')).toHaveText('Story card')
  await expect(mixed.locator('.file-card > .attachment-privacy-brand')).toHaveText(['机密附件', '机密附件删减版'])
  await expect(mixed.locator('.content-placeholder-denied.content-placeholder-media')).toHaveCount(1)
  await expect(mixed.locator('.private-image-block-brand-text')).toHaveText(['机密附件', '机密附件删减版'])
  for (const image of await mixed.locator('.img-frame > img').all()) {
    await image.scrollIntoViewIfNeeded()
    await expect(image.locator('..')).toHaveAttribute('data-image-loaded', '')
  }
  await mixed.evaluate((strip) => {
    strip.scrollLeft = 0
  })
  await expect(mixed.locator('.img-frame[data-image-loaded]')).toHaveCount(4)
  await expect(root.locator('p .carousel-item .carousel-caption')).toHaveText('Inline caption')
  await expect(root.locator('p').filter({ hasText: 'Before' })).toContainText('normal prose')
  await expect(root.locator('p').filter({ hasText: 'after' })).toContainText('normal prose')
  const ordinary_links = root.locator('p').filter({ hasText: 'Public ordinary link' }).locator('a')
  await expect(ordinary_links).toHaveCount(3)
  await expect(ordinary_links.nth(0)).toHaveAttribute('href', '/api/links/attachments/9001?version=fixture')
  await expect(ordinary_links.nth(1)).toHaveAttribute('href', '/api/links/attachments/9002?version=fixture')

  for (const narrow of [false, true]) {
    if (narrow)
      await page.getByTestId('layout-narrow').click()
    for (const theme of ['light', 'dark']) {
      await page.evaluate(value => document.documentElement.classList.toggle('dark', value === 'dark'), theme)
      const [private_colors, redacted_colors] = await mixed.locator('.file-card-private').evaluateAll(cards => cards.map(card => ({
        brand: getComputedStyle(card.querySelector('.attachment-privacy-brand')!).color,
        border: getComputedStyle(card).borderBottomColor,
        body: ['.file-card-name', '.file-card-icon'].map(selector => getComputedStyle(card.querySelector(selector)!).color),
      })))
      expect(private_colors?.border).toBe(private_colors?.brand)
      expect(redacted_colors?.border).toBe(redacted_colors?.brand)
      expect(private_colors?.brand).not.toBe(redacted_colors?.brand)
      expect(private_colors?.body).toEqual(redacted_colors?.body)
      // Card backgrounds transition after a theme change; compare at rest.
      await expect(async () => {
        const surfaces = await mixed.evaluate((strip) => {
          const style = (selector: string) => getComputedStyle(strip.querySelector(selector)!)
          return {
            file: style('.file-card').backgroundColor,
            story: style('.story-card').backgroundColor,
            placeholder: style('.content-placeholder-denied').backgroundColor,
            image: style('.img-frame').backgroundColor,
            caption: style('.carousel-caption').backgroundColor,
            border: style('.file-card').borderTopWidth,
          }
        })
        expect(surfaces).toMatchObject({ story: surfaces.file, placeholder: surfaces.file, image: surfaces.file, border: '0px' })
        expect(surfaces.caption).not.toBe(surfaces.file)
      }).toPass({ timeout: 3000 })
      const link_colors = await ordinary_links.evaluateAll(links => links.map((link) => {
        const style = getComputedStyle(link)
        const icon = getComputedStyle(link.querySelector('.link-card-icon')!)
        return [style.color, style.backgroundColor, style.borderBottomColor, icon.color, style.borderBottomWidth]
      }))
      expect(link_colors[0]).toEqual(link_colors[2])
      expect(link_colors[1]).toEqual(link_colors[2])
      expect(link_colors[0]?.[2]).toBe(link_colors[0]?.[3])
      expect(link_colors[0]?.[4]).toBe('4px')
      const card_lines = await mixed.locator('.link-card').evaluateAll(cards => cards.map((card) => {
        const style = getComputedStyle(card)
        return { width: style.borderBottomWidth, border: style.borderBottomColor }
      }))
      expect(card_lines.map(line => line.width)).toEqual(['4px', '4px', '4px', '4px'])
      expect(new Set(card_lines.map(line => line.border)).size).toBe(4)
      const story_line_matches = await mixed.locator('.story-card').evaluate(card => getComputedStyle(card).borderBottomColor === getComputedStyle(card.querySelector('.story-card-brand')!).backgroundColor)
      expect(story_line_matches).toBe(true)
      const geometry = await mixed.evaluate((strip) => {
        const items = [... strip.children].filter(element => ! element.classList.contains('carousel-space')).map((element) => {
          const rect = element.getBoundingClientRect()
          const private_body = element.querySelector('.private-image-block')?.getBoundingClientRect()
          const caption = element.querySelector('.carousel-caption')?.getBoundingClientRect()
          return { left: rect.left, right: rect.right, bottom: rect.bottom, privateBottom: private_body?.bottom, captionBottom: caption?.bottom, width: rect.width }
        })
        const parent = strip.closest('[data-testid="layout-preview"]')!.getBoundingClientRect()
        const spaces = [... strip.querySelectorAll('.carousel-space')].map(element => ({ width: element.getBoundingClientRect().width, em: Number.parseFloat(getComputedStyle(element).fontSize) }))
        return { items, spaces, right: strip.getBoundingClientRect().right, parentRight: parent.right, width: strip.clientWidth, max: strip.scrollWidth - strip.clientWidth }
      })
      expect(geometry.max).toBeGreaterThan(0)
      expect(geometry.right).toBeLessThanOrEqual(geometry.parentRight + 1)
      for (const [index, item] of geometry.items.entries()) {
        expect(item.bottom).toBeCloseTo(geometry.items[0]!.bottom, 0)
        expect(item.width).toBeLessThanOrEqual(geometry.width + 1)
        if (index) {
          const space = geometry.spaces[index - 1]!
          expect(space.width).toBeCloseTo(space.em * 0.5, 1)
          expect(item.left - geometry.items[index - 1]!.right).toBeCloseTo(space.width, 0)
        }
        if (item.privateBottom !== undefined)
          expect(item.privateBottom).toBeCloseTo(item.bottom, 0)
        if (item.captionBottom !== undefined)
          expect(item.captionBottom).toBeCloseTo(item.bottom, 0)
      }
      await page.screenshot({ path: info.outputPath(`mixed-${narrow ? 'narrow' : 'wide'}-${theme}.png`) })
    }
  }

  const inline_image = root.locator('img[alt="Inline caption"]')
  await inline_image.scrollIntoViewIfNeeded()
  await expect(inline_image.locator('..')).toHaveAttribute('data-image-loaded', '')
  for (const dark of [false, true]) {
    await page.evaluate(value => document.documentElement.classList.toggle('dark', value), dark)
    const filter = dark ? 'brightness(1.25)' : 'brightness(0.9)'
    for (const item of [ordinary_links.first(), mixed.locator('.file-card-private').first()]) {
      const colors = () => item.evaluate(element => [getComputedStyle(element).borderBottomColor, ... [... element.querySelectorAll('span')].map(span => getComputedStyle(span).color)])
      const resting = await colors()
      await item.hover()
      await expect(item).toHaveCSS('filter', filter)
      expect(await colors()).toEqual(resting)
    }
    await inline_image.hover()
    await expect(inline_image).toHaveCSS('filter', filter)
  }
  await page.evaluate(() => document.documentElement.classList.remove('dark'))
  await mixed.evaluate((strip) => {
    strip.scrollLeft = 0
  })

  const first_cards = strips.nth(1)
  const second_cards = strips.nth(2)
  const denied_card = first_cards.locator(':scope > .content-placeholder-inline')
  await expect(denied_card).toHaveText('你无权查看此处的机密附件')
  await expect(denied_card).toHaveCSS('flex-shrink', '0')
  const denied_lines = await denied_card.locator('.content-placeholder-text').evaluate((label) => {
    const text = document.createRange()
    text.selectNodeContents(label)
    return text.getClientRects().length
  })
  expect(denied_lines).toBe(1)
  const denied_geometry = await denied_card.evaluate((card) => {
    const rect = card.getBoundingClientRect()
    return { width: rect.width, height: rect.height, scrollWidth: card.scrollWidth }
  })
  expect(denied_geometry.width).toBeGreaterThanOrEqual(192)
  expect(denied_geometry.height).toBeLessThan(60)
  expect(denied_geometry.scrollWidth).toBeLessThanOrEqual(denied_geometry.width)
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

test('keeps inline link boxes and wrapped media separated while retaining authored carousel spacing', async ({ page }) => {
  await page.goto('/markdown-layout?spacing=1')
  await ready(page)
  const root = page.getByTestId('layout-preview')
  const denied_paragraph = root.locator('p').filter({ has: page.locator('.content-placeholder-denied.content-placeholder-media') })
  await expect(denied_paragraph).toHaveCount(1)
  const denied_media = denied_paragraph.locator(':scope > .carousel-item')
  await expect(denied_media).toHaveCount(3)
  const denied_boxes = await denied_media.evaluateAll(items => items.map((item) => {
    const { top, bottom, left } = item.getBoundingClientRect()
    return { top, bottom, left }
  }))
  expect(denied_boxes[1]!.top).toBeCloseTo(denied_boxes[0]!.top, 0)
  expect(denied_boxes[2]!.left).toBeCloseTo(denied_boxes[0]!.left, 0)
  expect(denied_boxes[2]!.top - Math.max(denied_boxes[0]!.bottom, denied_boxes[1]!.bottom)).toBeGreaterThan(0)

  await page.getByTestId('layout-narrow').click()
  const prose_links = root.locator('p > .link-chip')
  await expect(prose_links).toHaveCount(2)
  const [short, long] = await prose_links.evaluateAll(links => links.map((link) => {
    const bounds = (rect: DOMRect) => ({ top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right })
    const label = document.createRange()
    label.selectNodeContents(link.querySelector('.link-card-label')!)
    return {
      box: bounds(link.getBoundingClientRect()),
      paragraph: bounds(link.parentElement!.getBoundingClientRect()),
      fragments: [... label.getClientRects()].filter(rect => rect.width > 0 && rect.height > 0).map(bounds),
      file_top: link.nextElementSibling?.getBoundingClientRect().top,
    }
  }))
  expect(short!.file_top! - short!.box.bottom).toBeGreaterThan(0)
  expect(new Set(long!.fragments.map(rect => Math.round(rect.top))).size).toBeGreaterThan(1)
  expect(long!.box.left).toBeGreaterThanOrEqual(long!.paragraph.left - 0.5)
  expect(long!.box.right).toBeLessThanOrEqual(long!.paragraph.right + 0.5)
  for (const fragment of long!.fragments) {
    expect(fragment.left).toBeGreaterThanOrEqual(long!.box.left - 0.5)
    expect(fragment.right).toBeLessThanOrEqual(long!.box.right + 0.5)
    expect(fragment.top).toBeGreaterThanOrEqual(long!.box.top - 0.5)
    expect(fragment.bottom).toBeLessThanOrEqual(long!.box.bottom + 0.5)
  }
  const strip = root.locator('.carousel-shell').first().locator(':scope > .image-carousel')
  const unwrapped = root.locator('p').filter({ hasText: 'Unwrapped media' })
  await expect(unwrapped.locator(':scope > .carousel-item')).toHaveCount(1)
  await expect(unwrapped.locator(':scope > .file-card')).toHaveCount(1)
  await expect(unwrapped.locator('.carousel-shell')).toHaveCount(0)
  await expect(strip.locator('.carousel-space')).toHaveCount(1)
  const [a, b, space, c] = await strip.locator(':scope > *').evaluateAll(nodes => nodes.map((node) => {
    const { left, right, width } = node.getBoundingClientRect()
    return { left, right, width, em: Number.parseFloat(getComputedStyle(node).fontSize) }
  }))
  expect(b!.left).toBeCloseTo(a!.right, 0)
  expect(space!.width).toBeCloseTo(space!.em * 0.5, 1)
  expect(c!.left - b!.right).toBeCloseTo(space!.width, 0)
})

test('renders mixed Markdown in a scrollable carousel and keeps nested navigation separate', async ({ page }) => {
  await page.goto('/markdown-layout?spacing=1')
  await ready(page)
  await page.getByTestId('layout-narrow').click()
  const root = page.getByTestId('layout-preview')
  const shell = root.locator('.carousel-shell').filter({ hasText: '轮播里的标题' })
  const strip = shell.locator(':scope > .image-carousel')
  await expect(strip).toContainText(/111\s*222\s*333/)
  await expect(strip.getByRole('heading', { name: '轮播里的标题' })).toHaveCSS('position', 'static')
  await expect(strip.locator('li')).toHaveText(['列表甲', '列表乙'])
  await expect(strip.locator('blockquote')).toHaveText('轮播里的引用')
  await expect(strip.locator('table td').first()).toHaveText('表格甲')
  await expect(strip.locator('pre code')).toHaveText('轮播里的代码')

  const nested = strip.locator('.carousel-shell > .image-carousel')
  await expect(nested).toHaveCount(1)
  await expect(nested).toContainText('内层轮播')
  await expect.poll(() => strip.evaluate(element => element.scrollWidth - element.clientWidth)).toBeGreaterThan(0)
  await shell.locator(':scope > .carousel-next').click()
  await expect.poll(() => strip.evaluate(element => element.scrollLeft)).toBeGreaterThan(0)
  expect(await nested.evaluate(element => element.scrollLeft)).toBe(0)

  const inline = root.locator('p > #inline-carousel-fixture.author-carousel')
  await expect(inline).toHaveAttribute('title', 'A > B')
  await expect(inline).toHaveCSS('width', '180px')
  await expect(inline.locator('..')).toHaveText(/^起始 .* 结尾$/)
  const inline_strip = inline.locator(':scope > .image-carousel')
  await inline.locator(':scope > .carousel-next').click()
  await expect.poll(() => inline_strip.evaluate(element => element.scrollLeft)).toBeGreaterThan(0)
})

test('lazy body and covers show a readable load state, while an opened large image loads immediately', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  const requests = new Set<string>()
  let release!: () => void
  let release_retry!: () => void
  let preview_requests = 0
  const pending = new Promise<void>(resolve => release = resolve)
  const retry_pending = new Promise<void>(resolve => release_retry = resolve)
  await page.route('**/api/e2e-css-image?name=*', async (route) => {
    const name = new URL(route.request().url()).searchParams.get('name')!
    requests.add(name)
    if (name === 'broken-large') {
      preview_requests ++
      await (preview_requests === 1 ? pending : retry_pending)
      await route.fulfill({ status: 404, headers: { 'cache-control': 'no-store' } })
    }
    else {
      await pending
      await route.continue()
    }
  })
  try {
    await page.goto('/markdown-layout?loading=1', { waitUntil: 'domcontentloaded' })
    await ready(page)
    const covers = page.locator('.content-cover')
    await expect(covers).toHaveCount(2)
    for (const cover of await covers.all()) {
      await expect(cover.locator('img')).toHaveAttribute('loading', 'lazy')
      await expect(cover).toHaveAttribute('aria-busy', 'true')
      await expect(cover.getByRole('status')).toBeVisible()
      const colors = await cover.evaluate(frame => [getComputedStyle(frame).backgroundColor, getComputedStyle(frame.querySelector('.image-loading-mask')!, '::before').backgroundColor])
      expect(colors[0]).toBe(colors[1])
    }
    await expect(covers.first()).toHaveAttribute('data-lqip', '')
    expect(requests.has('lazy-body')).toBe(false)
    expect(requests.has('broken-large')).toBe(false)

    const open_preview = page.getByRole('button', { name: '打开测试大图' })
    await open_preview.click()
    const canvas = page.locator('.viewer-container:not(.viewer-hide) .viewer-canvas')
    const unavailable = canvas.locator('.viewer-image-unavailable')
    await expect(canvas).toHaveClass(/viewer-loading/)
    await expect(canvas.getByRole('status')).toHaveText('图片加载中')
    await expect(unavailable).toBeHidden()
    await expect(canvas.locator('.image-loading-mask .iconify')).toHaveCSS('animation-name', 'image-loading-spin')
    expect(await canvas.evaluate(element => getComputedStyle(element, '::before').backgroundImage)).toBe('none')
    await expect.poll(() => preview_requests).toBe(1)
    release()
    await expect(canvas.getByRole('status')).toHaveText('图片加载失败')
    await expect(unavailable).toHaveCSS('animation-name', 'viewer-image-appear')
    await expect(unavailable).toHaveCSS('animation-duration', '0.6s')
    await expect(canvas).not.toHaveClass(/viewer-loading/)
    await page.keyboard.press('Escape')
    await expect(canvas).toHaveCount(0)

    await open_preview.click()
    await expect(canvas.getByRole('status')).toHaveText('图片加载中')
    await expect(unavailable).toBeHidden()
    await expect.poll(() => preview_requests).toBe(2)
    release_retry()
    await expect(canvas.getByRole('status')).toHaveText('图片加载失败')
    await page.keyboard.press('Escape')
    await expect(canvas).toHaveCount(0)
    await expect(page.locator('.content-cover[data-image-loaded]')).toHaveCount(2)

    const body_image = page.getByRole('button', { name: '预览：Lazy body' })
    await expect(body_image).toHaveAttribute('loading', 'lazy')
    await body_image.scrollIntoViewIfNeeded()
    await expect.poll(() => requests.has('lazy-body')).toBe(true)
    await expect(body_image.locator('..')).toHaveAttribute('data-image-loaded', '')
  }
  finally {
    release()
    release_retry()
  }
})

test('fades in the large image at its fitted size from the first visible frame', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  let release!: () => void
  const pending = new Promise<void>(resolve => release = resolve)
  await page.route('**/api/e2e-css-image?name=fade-large', async (route) => {
    await pending
    await route.continue()
  })

  try {
    await page.goto('/markdown-layout?loading=1&preview=fade', { waitUntil: 'domcontentloaded' })
    await ready(page)
    await page.getByRole('button', { name: '打开测试大图' }).click()
    const canvas = page.locator('.viewer-container:not(.viewer-hide) .viewer-canvas')
    await expect(canvas.locator('.image-loading-mask')).toHaveCSS('opacity', '1')
    await canvas.evaluate((element) => {
      const frames: { opacity: number, mask_opacity: number, width: number, height: number }[] = []
      const image = element.querySelector('img')!
      const mask = element.querySelector('.image-loading-mask')!
      function sample() {
        const style = getComputedStyle(image)
        const opacity = Number(style.opacity)
        if (element.getAttribute('data-image-state') === 'loaded' && style.visibility === 'visible' && opacity > 0) {
          const { width, height } = image.getBoundingClientRect()
          frames.push({ opacity, mask_opacity: Number(getComputedStyle(mask).opacity), width, height })
          if (opacity === 1) {
            element.setAttribute('data-test-preview-frames', JSON.stringify(frames))
            return
          }
        }
        if (element.isConnected)
          requestAnimationFrame(sample)
      }
      requestAnimationFrame(sample)
    })

    release()
    await expect(canvas).toHaveAttribute('data-test-preview-frames', /^\[/)
    await expect(canvas.locator('img')).toHaveCSS('animation-name', 'viewer-image-appear')
    await expect(canvas.locator('img')).toHaveCSS('animation-duration', '0.6s')
    const frames = JSON.parse((await canvas.getAttribute('data-test-preview-frames'))!) as {
      opacity: number
      mask_opacity: number
      width: number
      height: number
    }[]
    const final = frames.at(- 1)!
    expect(final.width).toBeGreaterThan(500)
    expect(frames[0]!.opacity).toBeLessThan(0.25)
    expect(frames.some(frame => frame.opacity > 0.1 && frame.opacity < 0.9 && frame.mask_opacity > 0.1 && frame.mask_opacity < 0.9)).toBe(true)
    for (const frame of frames) {
      expect(frame.width).toBeCloseTo(final.width, 0)
      expect(frame.height).toBeCloseTo(final.height, 0)
    }
    await page.keyboard.press('Escape')
    await expect(canvas).toHaveCount(0)
  }
  finally {
    release()
  }
})
