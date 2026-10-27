import { expect } from '@playwright/test'
import { create_story, login, markdown, ready, test } from '../support/e2e-browser'

test('a higher-level heading covers an exiting lower-level heading', async ({ page }) => {
  await login(page)
  const { id, title } = await create_story(page)
  await page.goto(`/content/${id}/edit`)
  await ready(page)
  const paragraphs = Array.from({ length: 30 }, (_, index) => `Paragraph ${index}`).join('\n\n')
  const body = `# First chapter\n\n## Exiting subsection\n\n${paragraphs}\n\n## Next subsection\n\n${paragraphs}`
  await page.getByRole('textbox', { name: '档案内容 Markdown 编辑器', exact: true }).fill(markdown(title, body))
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect(page.getByText('档案已保存', { exact: true })).toBeVisible()
  await page.goto(`/content/${id}`)
  await ready(page)

  const overlap = await page.evaluate(async () => {
    const lower = [... document.querySelectorAll<HTMLElement>('.story-body h2')].find(heading => heading.textContent === 'Exiting subsection')!
    const higher = [... document.querySelectorAll<HTMLElement>('.story-body h1')].find(heading => heading.textContent === 'First chapter')!
    const next = [... document.querySelectorAll<HTMLElement>('.story-body h2')].find(heading => heading.textContent === 'Next subsection')!
    const end = next.getBoundingClientRect().top + window.scrollY
    for (let scroll = Math.max(0, end - window.innerHeight); scroll <= end; scroll += 2) {
      window.scrollTo(0, scroll)
      await new Promise(requestAnimationFrame)
      const a = higher.getBoundingClientRect()
      const b = lower.getBoundingClientRect()
      const top = Math.max(a.top, b.top)
      const bottom = Math.min(a.bottom, b.bottom)
      if (bottom - top > 4) {
        const x = Math.max(a.left, b.left, 0) + 10
        return {
          on_top: document.elementFromPoint(x, top + 2) === higher,
          background: getComputedStyle(higher).backgroundColor,
        }
      }
    }
    return null
  })
  expect(overlap).not.toBeNull()
  expect(overlap?.on_top).toBe(true)
  expect(overlap?.background).toBe('rgb(255, 255, 255)')

  // The fullscreen editor permits scrolling past the final line. Reproduce
  // that space here and check the last heading before its text has exited.
  await page.locator('.story-body').evaluate((body) => {
    body.style.paddingBottom = `${window.innerHeight}px`
  })
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  await page.waitForFunction(() => {
    const container = document.querySelector('.story-body')?.closest('.my-height-transition')
    return container && getComputedStyle(container).overflowY === 'visible'
  })
  const tail = await page.evaluate(async () => {
    const body = document.querySelector<HTMLElement>('.story-body')!
    const heading = [... body.querySelectorAll<HTMLElement>('h2')].find(item => item.textContent === 'Next subsection')!
    const paragraph = [... body.querySelectorAll<HTMLElement>('p')].at(- 1)!
    const dock = Number.parseFloat(getComputedStyle(heading).top)
    const end = paragraph.getBoundingClientRect().bottom + window.scrollY
    window.scrollTo(0, end - dock - heading.offsetHeight - 2)
    await new Promise(requestAnimationFrame)
    return {
      dock,
      top: heading.getBoundingClientRect().top,
      heading_bottom: heading.getBoundingClientRect().bottom,
      text_bottom: paragraph.getBoundingClientRect().bottom,
    }
  })
  expect(tail.text_bottom).toBeGreaterThan(tail.heading_bottom)
  expect(Math.abs(tail.top - tail.dock), JSON.stringify(tail)).toBeLessThanOrEqual(1)
})
