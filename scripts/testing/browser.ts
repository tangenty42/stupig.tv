import type { FullConfig } from '@playwright/test'
import { execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import { load_config } from '@config/loader'
import bcrypt from 'bcryptjs'
import mysql from 'mysql2/promise'
import { load_environment } from '../../config/lib/environment.mjs'
import { run_migrations } from '../migration/local'
import { start_cloud_draft_broker } from './cloud-draft-broker'
import { e2e_target } from './e2e-target'

export default async function setup(playwright: FullConfig) {
  const root = process.cwd()
  const production_css = playwright.metadata.productionCss === true
  const local = load_environment({ node_env: 'development' })
  if (! ['127.0.0.1', 'localhost'].includes(local.MYSQL_HOST ?? ''))
    throw new Error('Browser tests require a local development MySQL')
  if (! local.MYSQL_DEV_ROOT_PASSWORD)
    throw new Error('MYSQL_DEV_ROOT_PASSWORD is required to create an isolated E2E database')
  const run = randomUUID().replaceAll('-', '')
  const database = `stupig_e2e_${run}`
  const directory = resolve('.dev/e2e', run)
  // 与 playwright.config.ts 的 baseURL 同源，分片各占一个端口。
  const { port, baseUrl: base_url } = e2e_target(process.argv.slice(2), process.env.STUPIG_E2E_SHARD)
  // Never attach browser tests to an existing app backed by someone else's data.
  await new Promise<void>((accept, reject) => {
    const probe = createServer()
    probe.once('error', () => reject(new Error(`Port ${port} is unavailable; stop its owner before running E2E`)))
    probe.listen(port, 'localhost', () => probe.close(error => error ? reject(error) : accept()))
  })
  const environment = {
    ... local, NODE_ENV: 'development', BROWSERSLIST_ENV: 'production',
    MYSQL_USER: 'root', MYSQL_PASSWORD: local.MYSQL_DEV_ROOT_PASSWORD, MYSQL_DATABASE: database,
    APP_PORT: String(port), NUXT_OTP_DEBUG: 'true', NUXT_CAPTCHA_DEBUG: 'true',
    ALIYUN_OSS_ACCESS_KEY_ID: 'e2e-local-only', ALIYUN_OSS_ACCESS_KEY_SECRET: 'e2e-local-only',
    ALIYUN_DYPNS_ACCESS_KEY_ID: 'e2e-local-only', ALIYUN_DYPNS_ACCESS_KEY_SECRET: 'e2e-local-only',
    ALIYUN_DYPNS_CAPTCHA_APP_KEY: 'e2e-local-only', JWT_SECRET: randomUUID().repeat(2),
  }
  Object.assign(process.env, environment)
  // Compiler mode is independent of business deployment configuration. Even
  // the production-CSS profile uses local development fixtures and fake keys.
  const config = load_config({ ... environment, NODE_ENV: 'development' })
  // Local YAML overrides may point at a personal environment. Pin the test
  // destinations after loading and give all external integrations fake keys.
  config.db = { host: local.MYSQL_HOST!, port: Number(local.MYSQL_PORT), name: database, user: 'root', password: environment.MYSQL_PASSWORD }
  if (! ['127.0.0.1', 'localhost'].includes(local.REDIS_HOST ?? ''))
    throw new Error('Browser tests require a local Redis')
  config.redis = { host: local.REDIS_HOST!, port: Number(local.REDIS_PORT), password: local.REDIS_PASSWORD ?? '' }
  if (! ['127.0.0.1', 'localhost'].includes(local.MQTT_HOST ?? ''))
    throw new Error('Browser tests require a local MQTT broker')
  config.mqtt.host = local.MQTT_HOST!
  config.mqtt.port = Number(local.MQTT_TCP_PORT)
  config.mqtt.username = `e2e_${run}`
  config.mqtt.password = randomUUID().repeat(2)
  config.mqtt.web.wsUrl = `ws://${config.mqtt.host}:${local.MQTT_WS_PORT}/mqtt`
  config.app.auth.jwt.secret = environment.JWT_SECRET
  config.app.otp.debug = config.app.captcha.debug = true
  config.aliyun.oss = { region: 'oss-cn-shenzhen', endpoint: 'https://oss.invalid', bucket: 'e2e', publicBaseUrl: 'https://delivery.invalid',
    accessKeyId: 'e2e-local-only', accessKeySecret: 'e2e-local-only', timeoutMs: 1000, copyPartSizeMb: 8, uploadRoleArn: null }
  config.site.url = base_url
  config.site.indexable = false
  config.oss.buckets.public.publicBaseUrl = base_url
  config.aliyun.esa = { baseUrl: 'https://delivery.invalid', authKey: randomUUID().repeat(2), urlTtlSeconds: 300 }
  config.app.storageAudit.enabled = false
  config.app.contentPreload.enabled = false
  config.app.contentImages.enabled = false
  config.app.contentUploads.enabled = false
  config.app.contentRetirement.enabled = false
  config.integrations.mqtt.topicPrefix = `stupig/sync/e2e/${run}`
  const admin = await mysql.createConnection({ host: config.db.host, port: config.db.port, user: 'root', password: environment.MYSQL_PASSWORD })
  let created = false
  let child: ReturnType<typeof spawn> | undefined
  let draft_broker: Awaited<ReturnType<typeof start_cloud_draft_broker>> | undefined
  const logs: string[] = []
  const cleanup = async () => {
    await draft_broker?.stop()
    draft_broker = undefined
    if (child && child.exitCode === null && child.signalCode === null) {
      if (process.platform === 'win32' && child.pid)
        await promisify(execFile)('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
      else if (child.pid)
        process.kill(- child.pid, 'SIGTERM')
      await Promise.race([new Promise(resolve => child!.once('exit', resolve)), delay(5000)])
      if (child.exitCode === null)
        child.kill('SIGKILL')
    }
    if (child)
      await writeFile(resolve(directory, 'server.log'), logs.join(''))
    await rm(resolve(directory, 'runtime.json'), { force: true })
    if (created) {
      if (! /^stupig_e2e_[a-f\d]{32}$/.test(database))
        throw new Error('Unsafe E2E cleanup identity')
      await admin.query(`DROP DATABASE \`${database}\``)
      created = false
    }
    await admin.end()
  }
  try {
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`)
    created = true
    await run_migrations({ maintenance: true, database_config: config.db })
    draft_broker = await start_cloud_draft_broker(directory, { username: config.mqtt.username, password: config.mqtt.password }, async (input) => {
      const response = await fetch(`${base_url}/api/content-draft-sync/authenticate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input), signal: AbortSignal.timeout(5000) })
      if (! response.ok)
        return { result: 'deny' }
      return response.json()
    })
    config.mqtt.host = '127.0.0.1'
    config.mqtt.port = draft_broker.tcp_port
    config.mqtt.web.wsUrl = draft_broker.public_url
    config.mqtt.web.draftWsUrl = draft_broker.private_url
    const hash = await bcrypt.hash('AaAaAaAa888', 4)
    await admin.query(`INSERT INTO \`${database}\`.users (username, phone, password_hash, is_admin) VALUES (?, ?, ?, 1), (?, ?, ?, 0)`, ['admin', '19999999999', hash, 'user', '19000000000', hash])
    await mkdir(resolve(directory, 'config'), { recursive: true })
    // Use a source snapshot inside the fixture root. Nuxt's file discovery is
    // root-relative; pages outside it can otherwise include colocated tests.
    const copy_source = (name: string) => cp(resolve(root, name), resolve(directory, name), {
      recursive: true, filter: path => ! /\.(?:test|spec)\.[cm]?[jt]s$/.test(path),
    })
    await copy_source('app')
    await copy_source('server')
    await copy_source('config/esa')
    // Configuration loading is cwd-relative; fixture copies contain no secrets.
    for (const name of ['shared.yaml', 'dev.yaml', 'prod.yaml', 'app-settings.yaml'])
      await writeFile(resolve(directory, 'config', name), await readFile(resolve(root, 'config', name)))
    const runtime_path = resolve(directory, 'runtime.json')
    await writeFile(runtime_path, JSON.stringify(config), { mode: 0o600 })
    const settings_path = resolve(directory, 'settings.ts')
    const unix = (path: string) => path.replaceAll('\\', '/')
    const css_report_path = resolve(directory, 'css-build.json')
    if (production_css)
      process.env.STUPIG_E2E_CSS_REPORT = css_report_path
    await writeFile(settings_path, `import { settings as base } from '${unix(resolve(root, 'server/shared/settings.generated.ts'))}'\nexport const settings = { ...base, integrations: { ...base.integrations, mqtt: { ...base.integrations.mqtt, topicPrefix: '${config.integrations.mqtt.topicPrefix}' } } }\n`)
    const aliases = {
      '@config/loader': unix(resolve(root, 'tests/support/e2e-config.ts')),
      '@server/lib/aliyun-oss': unix(resolve(root, 'tests/support/e2e-storage.ts')),
      '@server/lib/captcha': unix(resolve(root, 'tests/support/e2e-captcha.ts')),
      '@server/lib/sms': unix(resolve(root, 'tests/support/e2e-sms.ts')),
      '@shared/settings': unix(settings_path),
    }
    await writeFile(resolve(directory, 'nuxt.config.ts'), `import { writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import base from '${unix(resolve(root, 'nuxt.config'))}'
const loadTailwind = createRequire(import.meta.url)('tailwindcss/loadConfig.js')
const tailwind = loadTailwind(${JSON.stringify(unix(resolve(root, 'tailwind.config.ts')))})
tailwind.content = [...tailwind.content, ${JSON.stringify(unix(resolve(root, 'tests/fixtures/e2e/app/**/*.{vue,ts}')))}]
export default defineNuxtConfig({
  ...base,
  extends: [${JSON.stringify(unix(resolve(root, 'tests/fixtures/e2e')))}],
  srcDir: ${JSON.stringify(unix(resolve(directory, 'app')))},
  plugins: [${JSON.stringify(unix(resolve(root, 'tests/fixtures/e2e/app/plugins/readiness.client.ts')))}],
  serverDir: ${JSON.stringify(unix(resolve(directory, 'server')))},
  dir: { public: ${JSON.stringify(unix(resolve(root, 'public')))} },
  modules: base.modules.filter(module => ${production_css} || module !== '@teages/nuxt-legacy').map(module => typeof module === 'string' && module.startsWith('./') ? ${JSON.stringify(unix(root))} + '/' + module : module),
  postcss: { ...base.postcss, plugins: { ...base.postcss?.plugins, tailwindcss: { config: tailwind } } },
  vite: {
    ...base.vite,
    optimizeDeps: { ...base.vite?.optimizeDeps, include: [...(base.vite?.optimizeDeps?.include || []), '@noble/hashes/legacy.js', '@noble/hashes/sha2.js', '@noble/hashes/utils.js'] },
    plugins: [
      ...(base.vite?.plugins || []),
      { name: 'css-production-evidence', configResolved(config) {
        if (${production_css} && !config.build.ssr) writeFileSync(${JSON.stringify(unix(css_report_path))}, JSON.stringify({
          nodeEnv: process.env.NODE_ENV, browserslistEnv: process.env.BROWSERSLIST_ENV,
          mode: config.mode, isProduction: config.isProduction,
          cssTarget: config.build.cssTarget, cssMinify: config.build.cssMinify,
          cssCodeSplit: config.build.cssCodeSplit, minify: config.build.minify,
          plugins: config.plugins.map(plugin => plugin.name),
        }, null, 2))
      } },
    ],
  },
  alias: { ...${JSON.stringify(aliases)}, ...base.alias, '@server': ${JSON.stringify(unix(resolve(directory, 'server')))} },
  nitro: {
    ...base.nitro,
    errorHandler: ${JSON.stringify(unix(resolve(directory, 'server/error-handler.ts')))},
    alias: { ...${JSON.stringify(aliases)}, '@server': ${JSON.stringify(unix(resolve(directory, 'server')))} },
    externals: { ...base.nitro?.externals, trace: false, external: ['ali-oss', 'sharp', 'mysql2', 'mqtt', '@aws-sdk/client-s3', '@aws-sdk/s3-request-presigner', '@alicloud/dypnsapi20170525', '@alicloud/openapi-client', '@alicloud/tea-util'] },
  },
  devtools: { enabled: false },
})\n`)
    const capture = (chunk: Buffer) => {
      logs.push(chunk.toString())
      if (logs.length > 500)
        logs.shift()
      writeFileSync(resolve(directory, 'server.log'), logs.join(''))
    }
    const launch = (args: string[], building = false) => {
      const process_child = spawn(process.execPath, args, {
        cwd: root, windowsHide: true, detached: process.platform !== 'win32',
        env: { ... process.env, ... environment, NODE_ENV: production_css && building ? 'production' : 'development', STUPIG_E2E_RUNTIME: runtime_path, STUPIG_E2E_URL: base_url, PORT: String(port), HOST: 'localhost' },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      process_child.stdout!.on('data', capture)
      process_child.stderr!.on('data', capture)
      return process_child
    }
    child = launch([resolve('node_modules/nuxt/bin/nuxt.mjs'), 'build', directory], true)
    await new Promise<void>((accept, reject) => {
      child!.once('error', reject)
      child!.once('exit', code => code === 0 ? accept() : reject(new Error(`E2E fixture build failed; see ${resolve(directory, 'server.log')}`)))
    })
    if (production_css) {
      const report = JSON.parse(await readFile(css_report_path, 'utf8'))
      const assets = resolve(directory, '.output/public/_nuxt')
      const files = await readdir(assets)
      const css = files.filter(name => name.endsWith('.css'))
      const legacy = files.filter(name => name.includes('legacy') && name.endsWith('.js'))
      if (report.nodeEnv !== 'production' || ! report.isProduction || ! report.cssCodeSplit || ! report.cssMinify || css.length < 2 || ! legacy.length)
        throw new Error('CSS production build did not retain production mode, minification, splitting and legacy assets')
      report.assets = {
        css: await Promise.all(css.map(async name => ({ name, bytes: (await stat(resolve(assets, name))).size }))),
        legacy,
      }
      await writeFile(css_report_path, JSON.stringify(report, null, 2))
    }
    child = launch([resolve(directory, '.output/server/index.mjs')])
    const deadline = Date.now() + 60_000
    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null)
        throw new Error(`Isolated Nuxt exited before readiness; see ${resolve(directory, 'server.log')}`)
      let response: Response | undefined
      try {
        response = await fetch(`${base_url}/healthz`, { signal: AbortSignal.timeout(3000) })
      }
      catch {}
      if (response?.ok) {
        console.log('E2E: isolated built application ready; real OSS/SMS are replaced at the boundary.')
        return cleanup
      }
      await delay(500)
    }
    await writeFile(resolve(directory, 'server.log'), logs.join(''))
    throw new Error(`Isolated Nuxt readiness timed out; see ${unix(resolve(directory, 'server.log'))}`)
  }
  catch (error) {
    await cleanup()
    throw error
  }
}
