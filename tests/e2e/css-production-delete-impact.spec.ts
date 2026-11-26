import { expect } from '@playwright/test'
import { create_story, login, test } from '../support/e2e-browser'

test('deletion references remain readable in both themes and on narrow screens', async ({ page }, info) => {
  await login(page)
  await create_story(page)
  // The visual fixture supplies only the read-only impact response. No delete is submitted.
  await page.route('**/api/trpc/content.getDeleteImpact*', route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify([{ result: { data: {
      targets: [{ kind: 'story', path: '待删除档案' }],
      sources: [
        { story_id: 10001, title: '蠢猪大闹食堂', references: [{ target: '待删除档案', line: 9, effect: 'missing' }] },
        { story_id: 10002, title: '这是一篇标题比较长的引用档案，用来检查窄屏里的自然换行', references: [{ target: '待删除档案', line: 12, effect: 'missing' }, { target: '待删除档案', line: 30, effect: 'missing' }, { target: '待删除档案', line: 0, effect: 'missing' }] },
      ],
      cloud_draft_references: true,
    } } }]),
  }))
  await page.getByRole('button', { name: '删除', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '空城计？', exact: true })
  await expect(dialog.getByRole('link', { name: '蠢猪大闹食堂', exact: true })).toBeVisible()
  await expect(dialog.getByText('第 12 行等、封面', { exact: true })).toBeVisible()
  await expect(dialog.getByRole('button', { name: '仍然删除', exact: true })).toBeEnabled()
  const reference = dialog.getByRole('link', { name: '蠢猪大闹食堂', exact: true })
  await expect(reference.locator('.iconify')).toHaveCount(1)
  const initial_link = (await reference.boundingBox())!
  await reference.hover()
  await expect(reference).toHaveCSS('text-decoration-line', 'none')
  await expect(reference).toHaveCSS('border-bottom-width', '1px')
  await expect(reference).toHaveCSS('box-shadow', / 0px 2px 0px 0px$/)
  expect((await reference.boundingBox())!.width).toBe(initial_link.width)
  await page.mouse.move(0, 0)
  for (const width of [960, 390]) {
    await page.setViewportSize({ width, height: 850 })
    for (const dark of [false, true]) {
      await page.evaluate(value => document.documentElement.classList.toggle('dark', value), dark)
      expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
      const bounds = await dialog.boundingBox()
      expect(bounds!.x).toBeGreaterThanOrEqual(0)
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width)
      const name = `delete-impact-${width}-${dark ? 'dark' : 'light'}`
      const screenshot = await dialog.screenshot({ path: info.outputPath(`${name}.png`) })
      await info.attach(name, { body: screenshot, contentType: 'image/png' })
    }
  }
  await dialog.getByRole('button', { name: '取消', exact: true }).click()
  await expect(dialog).toBeHidden()
})
