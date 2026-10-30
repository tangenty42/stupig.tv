import { writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { expect, test } from '@playwright/test'
import { style_root_id } from '../../config/ui-style'
import { build_css_official_fixture } from '../support/css-official-apis'
import { legacy_browser } from '../support/legacy-webdriver'

let fixture: Awaited<ReturnType<typeof build_css_official_fixture>>
let server: ReturnType<typeof createServer> | undefined
let origin: string

test.beforeAll(async ({ browserName: _browser_name }, info) => {
  if (! ['chromium80', 'firefox78'].includes(info.project.name))
    return
  fixture = await build_css_official_fixture()
  server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost')
    const output = url.pathname === '/postcss' ? 'postcss' : 'minified'
    const css = fixture.styles.application[output].global
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(`<!doctype html><html><head><style>${css}</style></head><body id="${style_root_id}"><div id="theme-probe" class="bg-white dark:bg-slate-900" style="width:160px;height:80px">Theme utility</div><div id="local-probe" class="!bg-white dark:!bg-slate-900" style="width:160px;height:80px">Local priority</div></body></html>`)
  })
  await new Promise<void>(accept => server!.listen(0, 'localhost', accept))
  const address = server.address()
  if (! address || typeof address === 'string')
    throw new Error('Legacy CSS fixture did not bind a loopback port')
  origin = `http://localhost:${address.port}`
})

test.afterAll(async () => {
  if (server) {
    server.closeAllConnections()
    await new Promise<void>((accept, reject) => server!.close(error => error ? reject(error) : accept()))
  }
})

for (const output of ['postcss', 'minified'] as const) {
  test(`${output}: minimum legacy engine applies dark background utilities`, async ({ browserName: _browser_name }, info) => {
    test.skip(! ['chromium80', 'firefox78'].includes(info.project.name), 'Run with tests/css-legacy-utilities.config.ts')
    const browser = await legacy_browser(info.project.name, info.outputPath())
    const observe = () => browser.execute('return {dark:document.documentElement.classList.contains("dark"),background:getComputedStyle(document.getElementById("theme-probe")).backgroundColor,localBackground:getComputedStyle(document.getElementById("local-probe")).backgroundColor,bodyBackground:getComputedStyle(document.body).backgroundColor}')
    let light: unknown
    try {
      expect(browser.capabilities.browserVersion.split('.')[0]).toBe(info.project.name === 'chromium80' ? '80' : '78')
      await browser.navigate(`${origin}/${output}`)
      light = await observe()
      expect(light).toMatchObject({ dark: false, background: 'rgb(255, 255, 255)', localBackground: 'rgb(255, 255, 255)' })
      await browser.execute('document.documentElement.classList.add("dark")')
      await expect.poll(async () => (await observe()).background, { timeout: 3000 }).toBe('rgb(15, 23, 42)')
      expect((await observe()).localBackground).toBe('rgb(15, 23, 42)')
    }
    finally {
      try {
        await writeFile(info.outputPath('theme.json'), JSON.stringify({ capabilities: browser.capabilities, output, light, dark: await observe() }, null, 2))
        await browser.screenshot(info.outputPath('theme.png'))
      }
      finally {
        await browser.close()
      }
    }
  })
}
