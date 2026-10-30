import { writeFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { expect, test } from '@playwright/test'
import { check_css_media } from '../support/css-media'
import { legacy_browser } from '../support/legacy-webdriver'

test('minimum legacy engine edits real Markdown, switches themes and opens the user menu', async ({ baseURL }, info) => {
  test.skip(! ['chromium80', 'firefox78'].includes(info.project.name), 'Run with tests/css-legacy.config.ts')
  // Three page loads and per-character native editing run under x64 emulation.
  test.setTimeout(300_000)
  const browser = await legacy_browser(info.project.name, info.outputPath())
  try {
    await test.step('hydrate the real content page', async () => {
      await browser.navigate(`${baseURL}/content`)
      await expect.poll(() => browser.execute('return !!window.__STUPIG_E2E_READY__?.() && !document.querySelector("#app-loading-mask")')).toBe(true)
    })
    await browser.click('button', '登录 / 注册')
    await browser.fill('#login-password-form input[name="username_or_phone"]', 'admin')
    await browser.fill('#login-password-form input[type="password"]', 'AaAaAaAa888')
    await expect.poll(() => browser.execute('return document.querySelector("#login-password-form input[name=username_or_phone]").value')).toBe('admin')
    await expect.poll(() => browser.execute('return document.querySelector("#login-password-form input[type=password]").value')).toBe('AaAaAaAa888')
    await browser.click('button', '立即登录')
    await expect.poll(() => browser.execute('return !!document.querySelector("[aria-label^=用户菜单：]")')).toBe(true)
    await browser.click('[aria-label^="用户菜单："]')
    await expect.poll(() => browser.execute('return document.querySelector("#user-hover-menu")?.getBoundingClientRect().height > 50')).toBe(true)
    await browser.navigate(`${baseURL}/admin`)
    await expect.poll(() => browser.execute('return !!window.__STUPIG_E2E_READY__?.() && !document.querySelector("#app-loading-mask") && !!document.querySelector(".p-autocomplete-input")')).toBe(true)
    const command_style = await browser.execute('var style=getComputedStyle(document.querySelector(".p-autocomplete-input"));return {font:style.fontFamily,size:style.fontSize,color:style.color,background:style.backgroundColor,dark:document.documentElement.classList.contains("dark")}')
    expect(command_style.font).toContain('monospace')
    expect(command_style.size).toBe('14px')
    expect(command_style.background).toBe('rgba(0, 0, 0, 0)')
    expect(command_style.color).toBe(command_style.dark ? 'rgb(226, 232, 240)' : 'rgb(30, 41, 59)')
    await writeFile(info.outputPath('command-style.json'), JSON.stringify(command_style, null, 2))
    await test.step('load an interactive Markdown editor', async () => {
      await browser.navigate(`${baseURL}/content/new/edit`)
      await expect.poll(() => browser.execute('return !!window.__STUPIG_E2E_READY__?.() && !document.querySelector("#app-loading-mask") && !!document.querySelector(".cm-content[contenteditable=true]")')).toBe(true)
    })
    const markdown = `---\ntitle: Legacy CSS draft\nlabel: #人上人\ntime: 2026/10/29\n---\n\n# Legacy chapter\n\n## Legacy section\n\n${Array.from({ length: 25 }, (_, index) => `Legacy paragraph ${index}`).join('\n\n')}`
    await test.step('replace the document using native input', () => browser.fill('.cm-content[contenteditable="true"]', markdown))
    await browser.click('button[aria-label="全屏编辑"]')
    await expect.poll(() => browser.execute('return document.querySelector(".editor-fullscreen .story-body h2")?.textContent')).toBe('Legacy section')
    const appearance = () => browser.execute('return {body:getComputedStyle(document.body).backgroundColor,overlay:getComputedStyle(document.querySelector(".editor-fullscreen")).backgroundColor,pane:getComputedStyle(document.querySelector(".editor-text-pane")).backgroundColor}')
    const light = await appearance()
    expect(light.overlay).toBe(light.body)
    expect(light.pane).toBe(light.body)
    const before = await browser.execute('return getComputedStyle(document.querySelector(".cm-content")).color')
    await browser.click('button[aria-label="退出全屏"]')
    await browser.click('button[aria-label="切换浅色 / 深色模式"]')
    await expect.poll(() => browser.execute('return getComputedStyle(document.querySelector(".cm-content")).color')).not.toBe(before)
    await browser.click('button[aria-label="全屏编辑"]')
    await expect.poll(() => browser.execute('return document.querySelector(".editor-fullscreen .story-body h2")?.textContent')).toBe('Legacy section')
    await expect.poll(async () => (await appearance()).pane).not.toBe(light.pane)
    const changed_theme = await appearance()
    expect(changed_theme.overlay).toBe(changed_theme.body)
    expect(changed_theme.pane).toBe(changed_theme.body)
    await browser.execute('var pane = document.querySelector(".editor-fullscreen .story-body").parentElement; pane.dispatchEvent(new WheelEvent("wheel")); pane.scrollTop = 300')
    await expect.poll(() => browser.execute('return document.querySelector(".editor-fullscreen .cm-scroller").scrollTop')).toBeGreaterThan(0)
    await browser.screenshot(info.outputPath('editor-fullscreen.png'))
    await browser.click('button[aria-label="退出全屏"]')
    await browser.resize(500, 900)
    await expect.poll(() => browser.execute('return document.documentElement.scrollWidth - document.documentElement.clientWidth')).toBeLessThanOrEqual(1)
    await writeFile(info.outputPath('editor.json'), JSON.stringify(await browser.execute('return {viewport:innerWidth,editorColor:getComputedStyle(document.querySelector(".cm-content")).color,dark:document.documentElement.classList.contains("dark"),text:document.querySelector(".cm-content").textContent}'), null, 2))
  }
  finally {
    try {
      await writeFile(info.outputPath('editor-diagnostics.json'), JSON.stringify({
        state: await browser.execute('return {url:location.pathname,editor:!!document.querySelector(".cm-content"),editable:document.querySelector(".cm-content")?.getAttribute("contenteditable"),error:window.__NUXT__?.error,legacyErrors:window.__LEGACY_ERRORS__,clientErrors:window.__STUPIG_E2E_CLIENT_ERRORS__,text:document.body.innerText.slice(0,1000)}'),
        layout: await browser.execute('return {viewport:innerWidth,width:document.documentElement.clientWidth,scrollWidth:document.documentElement.scrollWidth,overflow:Array.from(document.querySelectorAll("body *")).map(function(node){var rect=node.getBoundingClientRect();return {tag:node.tagName,classes:node.className,left:rect.left,right:rect.right,width:rect.width}}).filter(function(node){return node.width > 0 && (node.left < -1 || node.right > innerWidth + 1)}).slice(0,20)}'),
        console: await browser.console(),
      }, null, 2))
      await browser.screenshot(info.outputPath('editor-final.png'))
    }
    finally {
      await browser.close()
    }
  }
})

test('minimum legacy engine preserves animated media, loading, themes and narrow layout', async ({ baseURL }, info) => {
  test.skip(! ['chromium80', 'firefox78'].includes(info.project.name), 'Run with tests/css-legacy.config.ts')
  const browser = await legacy_browser(info.project.name, info.outputPath())
  try {
    await browser.navigate(`${baseURL}/css-media`)
    const observations = await check_css_media({ ... browser, capture: name => browser.screenshot(info.outputPath(`${name}.png`)) })
    await writeFile(info.outputPath('media.json'), JSON.stringify(observations, null, 2))
  }
  finally {
    try {
      await browser.screenshot(info.outputPath('media-final.png'))
      await writeFile(info.outputPath('media-dom.json'), JSON.stringify(await browser.execute('return {html:document.body.innerHTML,consoleErrors:window.__NUXT__?.error}'), null, 2))
    }
    finally {
      await browser.close()
    }
  }
})

test('minimum legacy engine hydrates production styles and interactive overlays', async ({ baseURL }, info) => {
  test.skip(! ['chromium80', 'firefox78'].includes(info.project.name), 'Run with tests/css-legacy.config.ts')
  const browser = await legacy_browser(info.project.name, info.outputPath())
  try {
    expect(browser.capabilities.browserVersion.split('.')[0]).toBe(info.project.name === 'chromium80' ? '80' : '78')
    await browser.navigate(`${baseURL}/css-production`)
    const observe = () => browser.execute(`return {
        userAgent: navigator.userAgent,
        hydrated: document.querySelector('[data-testid="css-hydration"]')?.textContent.trim(),
        ready: !!window.__STUPIG_E2E_READY__ && window.__STUPIG_E2E_READY__(),
        bodyId: document.body.id,
        text: document.body.innerText.slice(0, 3000),
        appError: window.__NUXT__ && window.__NUXT__.error,
        headings: Array.from(document.querySelectorAll('.story-body h1,.story-body h2,.story-body h3,.story-body h4,.story-body h5,.story-body h6')).map(function(node) { return getComputedStyle(node).zIndex }),
        headingPositions: Array.from(document.querySelectorAll('.story-body h1,.story-body h2,.story-body h3,.story-body h4,.story-body h5,.story-body h6')).map(function(node) { return getComputedStyle(node).position }),
        selectedColor: document.querySelector('.p-paginator-page-selected') ? getComputedStyle(document.querySelector('.p-paginator-page-selected')).color : null,
        has: CSS.supports('selector(:has(*))'),
        registerProperty: typeof CSS.registerProperty,
        scripts: Array.from(document.scripts).map(function(script) { return {src: script.src, type: script.type, noModule: script.noModule} }),
        resources: performance.getEntriesByType('resource').map(function(entry) { return entry.name })
      }`)
    let observation: any
    let stable = 0
    for (let attempt = 0; attempt < 30; attempt ++) {
      observation = await observe()
      if (observation.hydrated === 'client' && observation.ready)
        stable ++
      else
        stable = 0
      if (stable >= 3)
        break
      await delay(500)
    }
    const report = { capabilities: browser.capabilities, observation, console: await browser.console() }
    await writeFile(info.outputPath('engine.json'), JSON.stringify(report, null, 2))
    await browser.screenshot(info.outputPath('initial.png'))
    await info.attach('legacy-engine', { body: JSON.stringify(report, null, 2), contentType: 'application/json' })
    expect(observation.hydrated, 'Real production hydration must finish before interactive CSS acceptance').toBe('client')
    expect(observation.ready).toBe(true)
    expect(observation.headings).toEqual(['30', '29', '28', '27', '26', '25'])
    expect(observation.headingPositions).toEqual(Array.from({ length: 6 }).fill('sticky'))
    expect(observation.selectedColor).toBe('rgb(255, 255, 255)')
    await browser.execute(`window.__CSS_ANIMATIONS__ = []; window.__CSS_ANIMATION_ENDS__ = []; window.__CSS_ANIMATION_CANCELS__ = []; document.addEventListener('animationstart', function(event) { if (['card-in', 'card-out', 'p-confirmpopup-enter'].includes(event.animationName)) window.__CSS_ANIMATIONS__.push(event.animationName) }, true); document.addEventListener('animationend', function(event) { window.__CSS_ANIMATION_ENDS__.push(event.animationName) }, true); document.addEventListener('animationcancel', function(event) { window.__CSS_ANIMATION_CANCELS__.push(event.animationName) }, true)`)
    await browser.click('button', '首次打开懒加载弹窗')
    await expect.poll(() => browser.execute(`return !!document.querySelector('[role="dialog"]')`)).toBe(true)
    await expect.poll(() => browser.execute(`return window.__CSS_ANIMATIONS__`)).toContain('card-in')
    await expect.poll(() => browser.execute(`return getComputedStyle(document.querySelector('[role="dialog"]')).opacity`)).toBe('1')
    await expect.poll(() => browser.execute(`var transform = getComputedStyle(document.querySelector('[role="dialog"]')).transform; return transform === 'none' || new DOMMatrix(transform).isIdentity`)).toBe(true)
    const dialog = await browser.execute(`var node = document.querySelector('[role="dialog"]'); var style = getComputedStyle(node); return {width:style.width,radii:[style.borderTopLeftRadius,style.borderTopRightRadius,style.borderBottomRightRadius,style.borderBottomLeftRadius],padding:getComputedStyle(node.querySelector('.p-dialog-content')).paddingLeft}`)
    await writeFile(info.outputPath('dialog.json'), JSON.stringify(dialog, null, 2))
    await browser.screenshot(info.outputPath('dialog.png'))
    expect(dialog).toEqual({ width: '321px', radii: ['6.4px', '6.4px', '6.4px', '6.4px'], padding: '0px' })
    await browser.click('[role="dialog"] button[aria-label="关闭"]')
    await expect.poll(() => browser.execute(`return !!document.querySelector('[role="dialog"]')`)).toBe(false)
    await expect.poll(() => browser.execute(`return window.__CSS_ANIMATIONS__`)).toContain('card-out')
    await browser.click('button', '打开确认浮层')
    await expect.poll(() => browser.execute(`return !!document.querySelector('.p-confirmpopup')`)).toBe(true)
    await expect.poll(() => browser.execute(`return window.__CSS_ANIMATIONS__`)).toContain('p-confirmpopup-enter')
    await expect.poll(() => browser.execute(`return getComputedStyle(document.querySelector('.p-confirmpopup')).transform`)).toBe('none')
    await expect.poll(() => browser.execute(`return getComputedStyle(document.querySelector('.p-confirmpopup')).opacity`)).toBe('1')
    await browser.screenshot(info.outputPath('confirm-popup.png'))
    const position = await browser.execute(`var target = Array.from(document.querySelectorAll('button')).find(function(node) { return node.textContent.trim() === '打开确认浮层' }).getBoundingClientRect(); var popup = document.querySelector('.p-confirmpopup').getBoundingClientRect(); return {target:{left:target.left,right:target.right,top:target.top,bottom:target.bottom},popup:{left:popup.left,right:popup.right,top:popup.top,bottom:popup.bottom}}`)
    await writeFile(info.outputPath('popup-position.json'), JSON.stringify(position, null, 2))
    expect(position.popup.top).toBeGreaterThanOrEqual(position.target.bottom - 2)
    expect(position.popup.top).toBeLessThanOrEqual(position.target.bottom + 16)
    expect(position.popup.left).toBeLessThan(position.target.right)
    expect(position.popup.right).toBeGreaterThan(position.target.left)
    await browser.click('.p-confirmpopup button', '确定')
    await expect.poll(() => browser.execute(`return document.querySelector('[data-testid="css-confirm-result"]').textContent.trim()`)).toBe('confirmed')
    const animations = await browser.execute(`return {start:window.__CSS_ANIMATIONS__,end:window.__CSS_ANIMATION_ENDS__,cancel:window.__CSS_ANIMATION_CANCELS__}`)
    await writeFile(info.outputPath('animations.json'), JSON.stringify(animations, null, 2))
  }
  finally {
    try {
      const state = await browser.execute(`return {text:document.body.innerText.slice(0,3000),start:window.__CSS_ANIMATIONS__,end:window.__CSS_ANIMATION_ENDS__,cancel:window.__CSS_ANIMATION_CANCELS__,dialog:document.querySelector('[role="dialog"]')?.outerHTML,popup:document.querySelector('.p-confirmpopup')?.outerHTML}`)
      await writeFile(info.outputPath('final-state.json'), JSON.stringify(state, null, 2))
      await browser.screenshot(info.outputPath('final.png'))
    }
    catch {}
    await browser.close()
  }
})
