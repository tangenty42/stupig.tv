import { spawn } from 'node:child_process'
import { createConnection } from 'node:net'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { load_environment } from '../../config/lib/environment.mjs'
import { load_dev_auth_config } from './auth-config'
import { run_dev_tunnel } from './frp'

export async function run_development(args: string[] = []) {
  const config = load_dev_auth_config()
  if (args.some(arg => arg === '--port' || arg === '-p' || arg.startsWith('--port=')))
    throw new Error('Set APP_PORT through the development environment so the app and authorization proxy use the same port')
  // Do not start Nuxt's alternate-port fallback: the proxy must reach this app.
  await new Promise<void>((resolve, reject) => {
    const socket = createConnection({ port: config.proxy.targetPort, host: config.proxy.targetHost })
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
  const stop_tunnel = await run_dev_tunnel()
  let app: ReturnType<typeof spawn>
  try {
    app = spawn(process.execPath, [fileURLToPath(new URL('../../node_modules/nuxt/bin/nuxt.mjs', import.meta.url)), 'dev', '--dotenv', '.env.dev', '--host', '0.0.0.0', ... args, '--port', String(config.proxy.targetPort)], { stdio: 'inherit', windowsHide: true, env: load_environment({ node_env: 'development' }) })
  }
  catch (error) {
    stop_tunnel()
    throw error
  }
  let stopped = false
  let finish: (code: number) => void
  const completed = new Promise<number>((resolve) => {
    finish = resolve
  })
  const stop = (code = 0) => {
    if (stopped)
      return
    stopped = true
    stop_tunnel()
    app.kill()
    finish(code)
  }
  app.once('error', () => stop(1))
  app.once('exit', code => stop(code ?? 1))
  return { stop, completed }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const session = await run_development(process.argv.slice(2))
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
