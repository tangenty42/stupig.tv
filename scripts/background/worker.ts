import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Isolated process: app mode must be switched to worker before launching. */
export async function run_background_worker() {
  process.env.NODE_ENV ??= 'development'
  const { runtime_config } = await import('@config/loader')
  const config = runtime_config().app.backgroundRunner
  if (config.mode !== 'worker')
    throw new Error('Set app.backgroundRunner.mode to worker before starting a standalone worker')
  const { create_content_background_runner, content_background_adapters } = await import('@server/services/content/background.service')
  const { db } = await import('@server/lib/db')
  const { stop_mqtt_client } = await import('@server/lib/mqtt')
  const { redis } = await import('@server/lib/redis')
  const runner = create_content_background_runner()
  for (const adapter of content_background_adapters())
    runner.register(adapter)
  // The runner's timers are unref'd for Nitro. A standalone worker owns its lifetime.
  const keepalive = setInterval(() => {}, config.shutdownTimeoutMs)
  let stopping: Promise<void> | null = null
  function stop() {
    if (stopping)
      return stopping
    stopping = (async () => {
      const started = Date.now()
      const result = await runner.close()
      clearInterval(keepalive)
      process.off('SIGINT', signal)
      process.off('SIGTERM', signal)
      if (result.timed_out.length) {
        process.exitCode = 1
        return
      }
      redis.disconnect()
      let timer!: ReturnType<typeof setTimeout>
      try {
        await Promise.race([
          Promise.all([stop_mqtt_client(), db.end()]),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error('Worker cleanup timed out')), Math.max(1, config.shutdownTimeoutMs - (Date.now() - started)))
          }),
        ])
      }
      finally { clearTimeout(timer) }
    })()
    return stopping
  }
  function signal() {
    void stop().then(() => process.exit(process.exitCode ? 1 : 0), () => process.exit(1))
  }
  process.once('SIGINT', signal)
  process.once('SIGTERM', signal)
  return { runner, stop }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void run_background_worker().catch(() => {
    console.error('background_worker_start_failed: check app.backgroundRunner.mode and server configuration')
    process.exitCode = 1
  })
}
