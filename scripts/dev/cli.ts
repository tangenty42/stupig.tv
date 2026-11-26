import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createConnection } from 'node:net'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { load_environment } from '../../config/lib/environment.mjs'
import { load_dev_auth_config } from './auth-config'
import { prepare_dev_database_process } from './database'
import { start_dev_esa_notice } from './esa-notice'
import { run_dev_tunnel } from './frp'
import { dev_https_ca_path, dev_https_cert_path, dev_https_key_path } from './https'

export async function run_development(args: string[] = [], app_only = false) {
  if (args.some(arg => arg === '--port' || arg.startsWith('-p') || arg.startsWith('--port=')))
    throw new Error('Set APP_PORT through the development environment so the app and authorization proxy use the same port')
  if (args.some(arg => arg === '--host' || arg.startsWith('--host=') || arg.startsWith('-h') || arg === '--public' || arg.startsWith('--public=')))
    throw new Error('The development app listens on 127.0.0.1; do not override the listening host')
  if (args.some(arg => /^--(?:no-)?(?:https(?:\.[\w-]+)?|ssl[-\w]*|strict-?port|takeover)(?:=|$)/i.test(arg)))
    throw new Error('The development app requires HTTPS on the configured port; do not override its TLS or port policy')
  if (! [dev_https_ca_path, dev_https_cert_path, dev_https_key_path].every(path => existsSync(path)))
    throw new Error('Run pnpm dev:cert to prepare the local HTTPS certificates. See 本机 HTTPS 证书 in docs/1_workflows/1_develop/AGENT-DESIGN.md')
  const app_env = load_environment({ node_env: 'development' })
  const port = Number(app_env.APP_PORT ?? 3042)
  if (! Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('Set APP_PORT to a TCP port between 1 and 65535 in the development environment')
  if (! app_only && load_dev_auth_config(app_env).proxy.targetPort !== port)
    throw new Error('The authorization proxy targetPort must match APP_PORT')
  // Do not start Nuxt's alternate-port fallback: the proxy must reach this app.
  await new Promise<void>((resolve, reject) => {
    const socket = createConnection({ port, host: '127.0.0.1' })
    socket.setTimeout(2000)
    socket.once('connect', () => {
      socket.destroy()
      reject(new Error('Development app port is occupied; keep the existing app and use pnpm dev:tunnel instead'))
    })
    socket.once('error', (error: NodeJS.ErrnoException) => {
      socket.destroy()
      if (error.code === 'ECONNREFUSED')
        resolve()
      else
        reject(new Error('Cannot verify development app port; refusing to start another app'))
    })
    socket.once('timeout', () => {
      socket.destroy()
      reject(new Error('Development app port check timed out; refusing to start another app'))
    })
  })
  // Create or check the schema before the app or tunnel can serve requests.
  if (! app_only)
    await prepare_dev_database_process(app_env)
  const stop_tunnel = app_only ? undefined : await run_dev_tunnel()
  let app: ReturnType<typeof spawn>
  try {
    app = spawn(process.execPath, [
      fileURLToPath(new URL('../../node_modules/nuxt/bin/nuxt.mjs', import.meta.url)),
      'dev', '--dotenv', '.env.dev', '--host', '127.0.0.1', '--port', String(port), '--strictPort', '--no-takeover',
      '--https', '--https.cert', dev_https_cert_path, '--https.key', dev_https_key_path, ... args,
    ], {
      stdio: 'inherit',
      windowsHide: true,
      // SSR calls the app's own HTTPS endpoint through Node fetch.
      env: { ... app_env, NODE_USE_SYSTEM_CA: '1', NODE_EXTRA_CA_CERTS: app_env.NODE_EXTRA_CA_CERTS || dev_https_ca_path },
    })
  }
  catch (error) {
    stop_tunnel?.()
    throw error
  }
  let stopped = false
  const stop_notice = app_only ? undefined : start_dev_esa_notice(app_env)
  let finish: (code: number) => void
  const completed = new Promise<number>((resolve) => {
    finish = resolve
  })
  const stop = (code = 0) => {
    if (stopped)
      return
    stopped = true
    stop_notice?.()
    stop_tunnel?.()
    app.kill()
    finish(code)
  }
  app.once('error', () => stop(1))
  app.once('exit', code => stop(code ?? 1))
  return { stop, completed }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const app_only = process.argv[2] === '--app-only'
    const session = await run_development(process.argv.slice(app_only ? 3 : 2), app_only)
    process.once('SIGINT', () => session.stop())
    process.once('SIGTERM', () => session.stop())
    process.once('exit', () => session.stop())
    process.exitCode = await session.completed
  }
  catch (error) {
    console.error(`[dev] ${(error as Error).message}`)
    process.exitCode = 1
  }
}
