import type { CssOfficialProbe } from '../fixtures/css-official-apis/client'
import { expect, test } from '@playwright/test'
import { style_root_id } from '../../config/ui-style'
import { build_css_official_fixture, modes } from '../support/css-official-apis'

let fixture: Awaited<ReturnType<typeof build_css_official_fixture>>

test.beforeAll(async () => {
  fixture = await build_css_official_fixture()
})

for (const mode of modes) {
  for (const output of ['postcss', 'minified'] as const) {
    test(`${mode} / ${output}: official APIs and cascade boundaries`, async ({ page, browser }, test_info) => {
      const errors: string[] = []
      page.on('pageerror', error => errors.push(error.message))
      await page.route('**/*', route => route.abort())
      await page.setContent('<!doctype html><html><head></head><body id="css-app"><div id="__nuxt"></div></body></html>')
      await page.addStyleTag({ content: fixture.styles[mode][output].global }).then(element => element.evaluate(node => (node as HTMLStyleElement).id = 'probe-global-css'))
      await page.addStyleTag({ content: fixture.styles[mode][output].overrides }).then(element => element.evaluate(node => (node as HTMLStyleElement).id = 'probe-override-css'))
      await page.addStyleTag({ content: '#id-conflict#id-conflict { color: rgb(1, 2, 3) } .importance-probe { color: rgb(7, 8, 9) !important }' })
      await page.addScriptTag({ type: 'module', content: fixture.script })
      await page.waitForFunction(() => (window.__CSS_OFFICIAL_API_PROBE__ as CssOfficialProbe | undefined)?.ready)

      // Both a global preset and a per-instance dt survive real runtime style
      // generation; unrelated legacy variable overrides remain in the fixture.
      await expect(page.locator('#preset-input')).toHaveCSS('border-radius', '12px')
      await expect(page.locator('#scoped-input')).toHaveCSS('border-radius', '24px')
      await page.evaluate(() => window.__CSS_OFFICIAL_API_PROBE__.set_input_radius('16px'))
      await expect(page.locator('#preset-input')).toHaveCSS('border-radius', '16px')
      await expect(page.locator('#scoped-input')).toHaveCSS('border-radius', '24px')

      // The migrated application CSS must allow a preset to own this token.
      await expect(page.locator('#preset-button')).toHaveCSS('border-radius', '12px')

      const boosted = mode !== 'original'
      const button = page.locator('#utility-button')
      if (boosted) {
        await expect(button).toHaveCSS('padding-left', '0px')
        await expect(button).toHaveCSS('border-radius', '0px')
      }
      else {
        await expect(button).not.toHaveCSS('padding-left', '0px')
        await expect(button).not.toHaveCSS('border-radius', '0px')
      }
      await expect(button).toHaveCSS('width', mode === 'all-important' ? '32px' : '123px')
      await expect(button.locator('.p-button-label')).toHaveCSS('font-weight', '800')
      await expect(button.locator('.p-button-label')).toHaveCSS('letter-spacing', '1.6px')
      const variant = page.locator('#variant-button')
      if (boosted) {
        await expect(variant).toHaveCSS('background-color', 'rgb(255, 255, 255)')
        await expect(variant).toHaveCSS('padding-left', '8px')
        await variant.hover()
        await expect(variant).toHaveCSS('background-color', 'rgb(226, 232, 240)')
        await page.mouse.move(0, 0)
        await page.setViewportSize({ width: 500, height: 800 })
        await expect(variant).toHaveCSS('padding-left', '0px')
        await page.setViewportSize({ width: 1280, height: 800 })
        await expect(variant).toHaveCSS('padding-left', '8px')
      }

      await page.locator('#open-dialog').click()
      const dialog = page.locator('#probe-dialog')
      await expect(dialog).toBeVisible()
      expect(await dialog.evaluate(node => node.closest('#__nuxt') === null && node.closest('body')?.id === 'css-app')).toBe(true)
      const covers_teleport = mode === 'body-root' || mode === 'all-important'
      if (covers_teleport)
        await expect(dialog).toHaveCSS('border-radius', '0px')
      else
        await expect(dialog).not.toHaveCSS('border-radius', '0px')
      await expect(dialog).toHaveCSS('width', mode === 'all-important' ? '256px' : '321px')
      const content = page.getByTestId('dialog-content')
      if (covers_teleport)
        await expect(content).toHaveCSS('padding-left', '16px')
      await page.evaluate(() => window.__CSS_OFFICIAL_API_PROBE__.set_compact(true))
      if (covers_teleport)
        await expect(content).toHaveCSS('padding-left', '0px')
      else
        await expect(content).not.toHaveCSS('padding-left', '0px')

      const editor_content = page.locator('#conflict-editor .cm-content')
      await expect(editor_content).toHaveCSS('color', boosted ? 'rgb(239, 68, 68)' : 'rgb(25, 50, 75)')
      // A deliberately late library stylesheet still loses to the ancestor-ID
      // strategy; the test only moves its own fixture's style elements.
      await page.evaluate(() => {
        for (const style of document.querySelectorAll('style[data-primevue-style-id]'))
          document.head.appendChild(style)
      })
      if (boosted)
        await expect(button).toHaveCSS('border-radius', '0px')
      if (covers_teleport)
        await expect(dialog).toHaveCSS('border-radius', '0px')
      await expect(page.locator('#project-editor .cm-editor')).toHaveCSS('color', 'rgb(30, 41, 59)')
      const heading_spans = page.locator('#project-editor .cm-line').first().locator('span')
      await expect.poll(() => heading_spans.evaluateAll(nodes => nodes.map(node => getComputedStyle(node).color))).toContain('rgb(15, 23, 42)')
      await page.evaluate(() => window.__CSS_OFFICIAL_API_PROBE__.set_dark(true))
      await expect(page.locator('#project-editor .cm-editor')).toHaveCSS('color', 'rgb(226, 232, 240)')
      await expect(page.locator('#project-editor .cm-gutters')).toHaveCSS('color', 'rgb(100, 116, 139)')
      await expect.poll(() => heading_spans.evaluateAll(nodes => nodes.map(node => getComputedStyle(node).color))).toContain('rgb(241, 245, 249)')
      if (boosted)
        await expect(variant).toHaveCSS('background-color', 'rgb(15, 23, 42)')
      const warmed_styles = await page.locator('style').count()
      const warmed_rules = await page.evaluate(() => Array.from(document.styleSheets).reduce((sum, sheet) => sum + sheet.cssRules.length, 0))
      await page.evaluate(async () => {
        for (let i = 0; i < 20; i ++)
          await window.__CSS_OFFICIAL_API_PROBE__.set_dark(i % 2 === 0)
      })
      expect(await page.locator('style').count()).toBe(warmed_styles)
      expect(await page.evaluate(() => Array.from(document.styleSheets).reduce((sum, sheet) => sum + sheet.cssRules.length, 0))).toBe(warmed_rules)
      await expect(page.locator('#project-editor .cm-editor')).toHaveCSS('color', 'rgb(30, 41, 59)')

      await expect(page.locator('#id-conflict')).toHaveCSS('color', mode === 'all-important' ? 'rgb(239, 68, 68)' : 'rgb(1, 2, 3)')
      await expect(page.locator('#important-conflict')).toHaveCSS('color', 'rgb(7, 8, 9)')
      expect(errors).toEqual([])
      await test_info.attach('observations', { body: JSON.stringify({
        mode,
        output,
        browser: browser.version(),
        targets: fixture.targets,
        global_bytes: Buffer.byteLength(fixture.styles[mode][output].global),
        override_bytes: Buffer.byteLength(fixture.styles[mode][output].overrides),
        warmed_styles,
        warmed_rules,
        sample: await page.evaluate(() => ({
          button: getComputedStyle(document.querySelector('#utility-button')!).width,
          dialog: getComputedStyle(document.querySelector('#probe-dialog')!).width,
          body_root: document.body.id,
        })),
      }, null, 2), contentType: 'application/json' })
    })
  }
}

for (const output of ['postcss', 'minified'] as const) {
  test(`application / ${output}: migrated preset and local priority`, async ({ page }, test_info) => {
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await page.route('**/*', route => route.abort())
    await page.setContent(`<!doctype html><html><head></head><body id="${style_root_id}" data-theme="application"><div id="__nuxt"></div></body></html>`)
    await page.addStyleTag({ content: fixture.styles.application[output].global })
    await page.addStyleTag({ content: fixture.styles.application[output].overrides })
    await page.addScriptTag({ type: 'module', content: fixture.script })
    await page.waitForFunction(() => window.__CSS_OFFICIAL_API_PROBE__?.ready)
    await expect(page.locator('#preset-button')).toHaveCSS('border-radius', '32px')
    await expect(page.locator('#utility-button')).toHaveCSS('border-radius', '0px')
    await expect(page.locator('#utility-button')).toHaveCSS('width', '123px')
    await expect(page.locator('#variant-button')).toHaveCSS('background-color', 'rgb(255, 255, 255)')
    await expect(page.locator('#toggle-probe')).toHaveCSS('border-radius', '9999px')
    await expect(page.locator('#toggle-probe .p-togglebutton-content')).toHaveCSS('border-radius', '9999px')
    await expect(page.locator('#select-probe')).toHaveCSS('border-radius', '9999px')
    await expect(page.locator('#paginator-probe')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
    await expect(page.locator('#paginator-probe .p-paginator-page-selected')).toHaveCSS('color', 'rgb(255, 255, 255)')
    await page.locator('#open-menu').click()
    await expect(page.locator('#menu-probe')).toHaveCSS('box-shadow', 'rgba(0, 0, 0, 0.05) 0px 1px 2px 0px')
    await expect(page.locator('#menu-probe .p-menu-item-link')).toHaveCSS('padding-top', '6px')
    await expect(page.locator('#menu-probe .p-menu-item-link')).toHaveCSS('padding-left', '10px')
    await page.locator('#open-dialog').click()
    await expect(page.locator('#probe-dialog')).toBeVisible()
    await expect(page.locator('#probe-dialog')).toHaveCSS('border-radius', '6.4px')
    await expect(page.locator('#probe-dialog')).toHaveCSS('width', '321px')
    await expect(page.getByTestId('dialog-content')).toHaveCSS('padding-left', '16px')
    await page.evaluate(() => window.__CSS_OFFICIAL_API_PROBE__.set_compact(true))
    await expect(page.getByTestId('dialog-content')).toHaveCSS('padding-left', '0px')
    await expect(page.locator('#conflict-editor .cm-content')).toHaveCSS('color', 'rgb(239, 68, 68)')
    await page.evaluate(() => {
      for (const style of document.querySelectorAll('style[data-primevue-style-id]'))
        document.head.appendChild(style)
    })
    await expect(page.locator('#utility-button')).toHaveCSS('border-radius', '0px')
    await expect(page.locator('#utility-button')).toHaveCSS('width', '123px')
    await expect(page.getByTestId('dialog-content')).toHaveCSS('padding-left', '0px')
    const tokens = async () => page.evaluate(() => {
      const style = getComputedStyle(document.documentElement)
      return Object.fromEntries(['--p-toast-blur', '--p-autocomplete-overlay-border-radius', '--p-autocomplete-option-border-radius', '--p-datepicker-buttonbar-padding', '--p-contextmenu-item-padding'].map(name => [name, style.getPropertyValue(name).trim()]))
    })
    const expected_tokens = {
      '--p-toast-blur': '16px',
      '--p-autocomplete-overlay-border-radius': '0.4rem',
      '--p-autocomplete-option-border-radius': '0.4rem',
      '--p-datepicker-buttonbar-padding': '0.5rem 0 0.25rem 0',
      '--p-contextmenu-item-padding': '0.375rem 0.625rem',
    }
    await expect.poll(tokens).toEqual(expected_tokens)
    await page.evaluate(() => window.__CSS_OFFICIAL_API_PROBE__.set_dark(true))
    await expect(page.locator('#variant-button')).toHaveCSS('background-color', 'rgb(15, 23, 42)')
    await expect.poll(tokens).toEqual(expected_tokens)
    await expect(page.locator('#paginator-probe .p-paginator-page-selected')).toHaveCSS('color', 'rgb(255, 255, 255)')
    await expect(page.locator('#project-editor .cm-editor')).toHaveCSS('color', 'rgb(226, 232, 240)')
    expect(errors).toEqual([])
    await test_info.attach('application-preview', { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' })
  })
}
