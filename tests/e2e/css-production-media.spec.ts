import { check_css_media } from '../support/css-media'
import { ready, test } from '../support/e2e-browser'

test('production media preserves smooth fades, image loading and restored state across themes and widths', async ({ page }, info) => {
  await page.goto('/css-media')
  await ready(page)
  const observations = await check_css_media({
    execute: script => page.evaluate(`(() => { ${script} })()`),
    click: async selector => page.locator(selector).first().click(),
    capture: async (name) => {
      await page.screenshot({ path: info.outputPath(`${name}.png`) })
    },
  })
  await info.attach('media-state', { body: JSON.stringify(observations, null, 2), contentType: 'application/json' })
  await page.screenshot({ path: info.outputPath('media-narrow-dark.png') })
})
