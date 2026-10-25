import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { rootCertificates } from 'node:tls'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build_frpc_config, load_dev_auth_config } from './auth-config'
import { supervise_child } from './process.mjs'

export function prepare_dev_frp() {
  const config = load_dev_auth_config()
  const directory = resolve('.dev/auth')
  mkdirSync(directory, { recursive: true })
  const ca_path = resolve(directory, 'ca.pem')
  // frp 0.71.0 skips certificate verification without a CA file, including WSS.
  // Use Node's bundled public roots, never a freshly fetched unverified leaf.
  writeFileSync(ca_path, rootCertificates.join('\n'))
  const native = build_frpc_config(config, ca_path)
  const config_path = resolve(directory, 'frpc.json')
  writeFileSync(config_path, native.source)
  return { config, config_path, env: { ... process.env, DEV_FRP_TOKEN_JSON: native.token_json } }
}

export function verify_dev_frp(prepared: ReturnType<typeof prepare_dev_frp>) {
  const { config, config_path, env } = prepared
  const version = spawnSync(config.frp.executable, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 10000 })
  if (version.error || version.status !== 0)
    throw new Error('frpc cannot execute; check installation and operating system protection')
  if (version.stdout.trim() !== config.frp.version)
    throw new Error(`Install frpc ${config.frp.version} to match the configured server version`)
  const verified = spawnSync(config.frp.executable, ['verify', '-c', config_path], { env, windowsHide: true, timeout: 10000, stdio: 'pipe' })
  if (verified.error || verified.status !== 0)
    throw new Error('frpc configuration validation failed; no tunnel was started')
}

async function existing_proxy(config: ReturnType<typeof load_dev_auth_config>) {
  try {
    const response = await fetch(`http://${config.proxy.listenHost}:${config.proxy.listenPort}/`, { signal: AbortSignal.timeout(2000) })
    await response.body?.cancel()
    if (response.status !== 404 || response.headers.get('x-dev-auth-proxy') !== '1')
      throw new Error('Development proxy port is occupied by an unidentified process; stop it explicitly before starting the tunnel')
    return true
  }
  catch (error) {
    if ((error as { cause?: { code?: string } }).cause?.code === 'ECONNREFUSED')
      return false
    throw error
  }
}

export async function run_dev_tunnel() {
  const prepared = prepare_dev_frp()
  verify_dev_frp(prepared)
  const stops: (() => void)[] = []
  let health_timer: ReturnType<typeof setInterval> | undefined
  const shutdown = () => {
    clearInterval(health_timer)
    for (const stop of stops)
      stop()
  }
  const { config } = prepared
  if (! await existing_proxy(config)) {
    stops.push(supervise_child(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./auth-proxy.mjs', import.meta.url))]))
  }
  stops.push(supervise_child(config.frp.executable, ['-c', prepared.config_path], {
    env: prepared.env,
    onExit: () => console.error('[dev-auth] frpc exited; retrying in 5 seconds'),
  }))
  let checking = false
  let previous = ''
  async function check() {
    if (checking)
      return
    checking = true
    let state = 'callback unavailable'
    try {
      const response = await fetch(config.callbackUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', redirect: 'manual', signal: AbortSignal.timeout(5000) })
      state = response.status === 403 && response.headers.get('x-dev-auth-proxy') === '1'
        ? 'callback reachable (real grant/download acceptance still required)'
        : `unexpected callback response: ${response.status}`
      await response.body?.cancel()
    }
    catch { /* Keep failures visible without printing URLs, credentials or bodies. */ }
    finally { checking = false }
    if (state !== previous) {
      console.log(`[dev-auth] ${state}`)
      previous = state
    }
  }
  health_timer = setInterval(() => {
    void check()
  }, 10000)
  void check()
  return shutdown
}

export function handle_tunnel_signals(stop: () => void) {
  const shutdown = () => {
    stop()
    process.exit(0)
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
  process.once('exit', stop)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.includes('--prepare')) {
      prepare_dev_frp()
      console.log('[dev-auth] prepared frpc configuration and CA bundle; token is supplied only through the child environment')
    }
    else if (process.argv.includes('--verify')) {
      verify_dev_frp(prepare_dev_frp())
      console.log('[dev-auth] frpc version and native configuration verified; no tunnel started')
    }
    else { handle_tunnel_signals(await run_dev_tunnel()) }
  }
  catch (error) {
    console.error(`[dev-auth] ${(error as Error).message}`)
    process.exitCode = 1
  }
}
