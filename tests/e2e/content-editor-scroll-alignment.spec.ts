import { expect } from '@playwright/test'
import { create_story, login, markdown, ready, test } from '../support/e2e-browser'

test('fullscreen editor aligns with content below the pinned heading stack', async ({ page }) => {
  await login(page)
  const { id, title } = await create_story(page)
  await page.goto(`/content/${id}/edit`)
  await ready(page)
  const paragraphs = Array.from({ length: 90 }, (_, index) => `${index === 40 ? '## Next section\n\n### Next detail\n\n' : ''}Paragraph ${index}`).join('\n\n')
  await page.getByRole('textbox', { name: '档案内容 Markdown 编辑器', exact: true }).fill(markdown(title, `# Chapter\n\n## Subsection\n\n### Detail\n\n${paragraphs}`))
  await page.getByRole('button', { name: '全屏编辑', exact: true }).click()
  const preview = page.locator('.editor-fullscreen .story-body')
  await expect(preview.locator('h3').first()).toBeVisible()

  await preview.evaluate((body) => {
    const pane = body.parentElement!
    const target = [... body.querySelectorAll('p')].find(item => item.textContent === 'Paragraph 25')!
    pane.dispatchEvent(new WheelEvent('wheel'))
    for (let i = 0; i < 3; i ++) {
      const heading_bottom = body.querySelector('h3')!.getBoundingClientRect().bottom
      pane.scrollTop += target.getBoundingClientRect().top - heading_bottom
    }
  })
  const editor = page.locator('.editor-fullscreen .cm-scroller')
  await expect.poll(async () => editor.evaluate((scroller) => {
    const top = scroller.getBoundingClientRect().top
    return [... scroller.querySelectorAll<HTMLElement>('.cm-line')]
      .find(line => line.getBoundingClientRect().bottom > top + 1)?.textContent
  })).toContain('Paragraph 25')

  await editor.evaluate((scroller) => {
    scroller.dispatchEvent(new WheelEvent('wheel'))
    scroller.scrollTop += 180
  })
  await expect.poll(async () => {
    const visible_line = await editor.evaluate((scroller) => {
      const top = scroller.getBoundingClientRect().top
      return [... scroller.querySelectorAll<HTMLElement>('.cm-line')]
        .find(line => line.getBoundingClientRect().bottom > top + 1 && line.textContent?.trim())?.textContent ?? ''
    })
    const match = /Paragraph \d+/.exec(visible_line)
    if (! match)
      return Number.POSITIVE_INFINITY
    return preview.evaluate((body, text) => {
      const paragraph = [... body.querySelectorAll('p')].find(item => item.textContent === text)
      const heading = body.querySelector('h3')
      return paragraph && heading ? Math.abs(paragraph.getBoundingClientRect().top - heading.getBoundingClientRect().bottom) : Number.POSITIVE_INFINITY
    }, match[0])
  }).toBeLessThan(45)

  // Cross both heading changes while scrolling either pane up and down.
  // The opposite pane must not jump against the driver's direction.
  for (const driver of ['preview', 'editor'] as const) {
    for (const direction of [1, - 1]) {
      const samples = await page.evaluate(async ({ driver, direction }) => {
        const body = document.querySelector<HTMLElement>('.editor-fullscreen .story-body')!
        const pane = body.parentElement!
        const scroller = document.querySelector<HTMLElement>('.editor-fullscreen .cm-scroller')!
        const next = [... body.querySelectorAll<HTMLElement>('h2')].find(item => item.textContent === 'Next section')!
        pane.dispatchEvent(new WheelEvent('wheel'))
        body.classList.add('measuring')
        const boundary = next.getBoundingClientRect().top - pane.getBoundingClientRect().top + pane.scrollTop
        body.classList.remove('measuring')
        pane.scrollTop = boundary + (direction > 0 ? - 220 : 120)
        await new Promise(requestAnimationFrame)
        await new Promise(requestAnimationFrame)
        const source = driver === 'preview' ? pane : scroller
        const target = driver === 'preview' ? scroller : pane
        const positions = [target.scrollTop]
        for (let i = 0; i < 80; i ++) {
          source.dispatchEvent(new WheelEvent('wheel'))
          source.scrollTop += 4 * direction
          await new Promise(requestAnimationFrame)
          await new Promise(requestAnimationFrame)
          positions.push(target.scrollTop)
        }
        return positions
      }, { driver, direction })
      const changes = samples.slice(1).map((position, index) => (position - samples[index]!) * direction)
      expect((samples.at(- 1)! - samples[0]!) * direction, `${driver} did not follow the scroll`).toBeGreaterThan(20)
      expect(Math.min(... changes), `${driver} caused reverse jumps`).toBeGreaterThanOrEqual(- 2)
      expect(Math.max(... changes), `${driver} caused a large jump`).toBeLessThan(30)
    }
  }

  await preview.evaluate((body) => {
    const pane = body.parentElement!
    pane.dispatchEvent(new WheelEvent('wheel'))
    pane.scrollTop = 0
  })
  await expect.poll(() => editor.evaluate(scroller => scroller.scrollTop)).toBeLessThanOrEqual(1)
})
