import { spawn } from 'node:child_process'
import { mkdir, realpath, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { legacy_https } from './legacy-https'

/** Use matching historical drivers: current Playwright protocols target newer engines. */
export async function legacy_browser(engine: string, artifacts: string) {
  if (process.platform !== 'win32' || ! ['chromium80', 'firefox78'].includes(engine))
    throw new Error('The installed legacy browser fixtures require Windows and a declared engine')
  await mkdir(artifacts, { recursive: true })
  const port = await new Promise<number>((accept, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const selected = typeof address === 'object' && address ? address.port : 0
      server.close(error => error ? reject(error) : accept(selected))
    })
  })
  const chromium = engine === 'chromium80'
  // A worktree may share the installation through a Windows directory junction.
  const root = await realpath(resolve('.dev/tools/legacy-browsers'))
  const driver = resolve(root, chromium ? 'chromedriver/chromedriver.exe' : 'geckodriver/geckodriver.exe')
  const binary = resolve(root, chromium ? 'chromium/chrome-win/chrome.exe' : 'firefox/core/firefox.exe')
  const child = spawn(driver, chromium ? [`--port=${port}`, '--allowed-ips=127.0.0.1'] : ['--port', String(port), '--host', '127.0.0.1'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  const logs: string[] = []
  child.stdout.on('data', chunk => logs.push(chunk.toString()))
  child.stderr.on('data', chunk => logs.push(chunk.toString()))
  let launch_error: Error | undefined
  child.on('error', error => launch_error = error)
  let session: string | undefined
  let https: Awaited<ReturnType<typeof legacy_https>> | undefined
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method, headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(35_000),
    })
    const payload = await response.json()
    if (! response.ok || payload.value?.error)
      throw new Error(`WebDriver ${method} ${path}: ${payload.value?.message ?? response.status}`)
    return payload.value
  }
  const close = async () => {
    try {
      if (session)
        await call('DELETE', `/session/${session}`)
    }
    finally {
      child.kill()
      await writeFile(resolve(artifacts, 'driver.log'), logs.join(''))
      await https?.close()
    }
  }
  try {
    for (let attempt = 0; ; attempt ++) {
      if (launch_error)
        throw launch_error
      if (child.exitCode !== null)
        throw new Error(`Legacy driver exited: ${logs.join('')}`)
      try {
        await call('GET', '/status')
        break
      }
      catch (error) {
        if (attempt >= 30)
          throw error
        await delay(100)
      }
    }
    const capabilities = chromium
      ? { 'browserName': 'chrome', 'goog:chromeOptions': { binary, args: ['--headless', '--disable-gpu', '--no-first-run', '--disable-background-networking', '--disable-component-update', '--window-size=1280,900'] }, 'goog:loggingPrefs': { browser: 'ALL' } }
      : { 'browserName': 'firefox', 'moz:firefoxOptions': { binary, args: ['-headless'], prefs: { 'app.update.auto': false, 'app.update.enabled': false } } }
    const created = await call('POST', '/session', { capabilities: { alwaysMatch: { ... capabilities, pageLoadStrategy: 'eager', acceptInsecureCerts: true } } })
    session = created.sessionId
    await call('POST', `/session/${session}/timeouts`, { implicit: 10_000 })
    if (chromium) {
      await call('POST', `/session/${session}/goog/cdp/execute`, {
        cmd: 'Page.addScriptToEvaluateOnNewDocument',
        params: { source: `window.__LEGACY_ERRORS__ = []; function capture(error) { window.__LEGACY_ERRORS__.push({message:String(error && error.message || error),stack:error && error.stack}) } addEventListener('error',function(event){capture(event.error || event.message)}); addEventListener('unhandledrejection',function(event){capture(event.reason)}); addEventListener('vite:preloadError',function(event){capture(event.payload)})` },
      })
    }
    const execute = (script: string, args: unknown[] = []) => call('POST', `/session/${session}/execute/sync`, { script, args })
    return {
      capabilities: created.capabilities,
      execute,
      fill: async (selector: string, text: string) => {
        const node = await call('POST', `/session/${session}/element`, { using: 'css selector', value: selector })
        const element = node['element-6066-11e4-a52e-4f735466cecf']
        const editable = await execute('return arguments[0].isContentEditable', [node])
        if (editable) {
          // Use native selection/deletion so contenteditable editors observe
          // normal input events rather than Element Clear's DOM mutation.
          await call('POST', `/session/${session}/element/${encodeURIComponent(element)}/click`, {})
          await call('POST', `/session/${session}/element/${encodeURIComponent(element)}/value`, { text: '\uE009a\uE000\uE003' })
        }
        else {
          await call('POST', `/session/${session}/element/${encodeURIComponent(element)}/clear`, {})
        }
        // Bulk historical Send Keys loses form characters and stalls long
        // documents. Yield between native edits, preserving the full text.
        for (const character of text)
          await call('POST', `/session/${session}/element/${encodeURIComponent(element)}/value`, { text: character })
        if (! editable) {
          // Commit the real form's blur validation before the next action,
          // matching the modern login helper's native Tab operation.
          await call('POST', `/session/${session}/element/${encodeURIComponent(element)}/value`, { text: '\uE004' })
        }
      },
      resize: (width: number, height: number) => call('POST', `/session/${session}/window/rect`, { width, height }),
      click: async (selector: string, text?: string) => {
        for (let attempt = 0; ; attempt ++) {
          const node = text === undefined
            ? await call('POST', `/session/${session}/element`, { using: 'css selector', value: selector })
            : await execute(`var text = arguments[1]; return Array.from(document.querySelectorAll(arguments[0])).find(function(node) { return node.textContent.trim() === text })`, [selector, text])
          const element = node?.['element-6066-11e4-a52e-4f735466cecf']
          if (! element)
            throw new Error(`Legacy click target missing: ${selector} ${text ?? ''}`)
          try {
            await call('POST', `/session/${session}/element/${encodeURIComponent(element)}/click`, {})
            return
          }
          catch (error) {
            // Match locator semantics when hydration replaces the observed
            // node between lookup and native click. Other failures still fail.
            if (attempt >= 2 || ! String(error).includes('stale element reference'))
              throw error
          }
        }
      },
      navigate: async (input: string) => {
        const url = new URL(input)
        https ??= await legacy_https(url.origin)
        if (url.origin !== https.target)
          throw new Error('Legacy navigation must stay on the isolated application origin')
        return call('POST', `/session/${session}/url`, { url: `${https.origin}${url.pathname}${url.search}${url.hash}` })
      },
      screenshot: async (path: string) => writeFile(path, Buffer.from(await call('GET', `/session/${session}/screenshot`), 'base64')),
      console: async () => chromium ? call('POST', `/session/${session}/log`, { type: 'browser' }) : [],
      close,
    }
  }
  catch (error) {
    await close()
    throw error
  }
}
