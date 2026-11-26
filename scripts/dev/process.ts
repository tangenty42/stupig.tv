import type { SpawnOptions } from 'node:child_process'
import { spawn } from 'node:child_process'

/** Small owned-child boundary used by the runner and its lifecycle tests. */
interface SupervisedChild {
  once: (event: string, listener: () => void) => unknown
  kill: () => unknown
}

interface SuperviseOptions {
  spawn?: (command: string, args: string[], options: SpawnOptions) => SupervisedChild
  env?: NodeJS.ProcessEnv
  onExit?: () => void
  retryMs?: number
}

/** Own only children launched here; stopping must also cancel pending restarts. */
export function supervise_child(command: string, args: string[], options: SuperviseOptions = {}) {
  const launch = options.spawn ?? spawn
  let child: SupervisedChild | undefined
  let retry: ReturnType<typeof setTimeout> | undefined
  let stopped = false
  function start() {
    if (stopped)
      return
    let settled = false
    const finished = () => {
      if (settled)
        return
      settled = true
      child = undefined
      if (! stopped) {
        options.onExit?.()
        retry = setTimeout(start, options.retryMs ?? 5000)
      }
    }
    try {
      child = launch(command, args, { stdio: 'inherit', windowsHide: true, env: options.env ?? process.env })
      child.once('error', finished)
      child.once('exit', finished)
    }
    catch { finished() }
  }
  start()
  return () => {
    stopped = true
    if (retry)
      clearTimeout(retry)
    child?.kill()
  }
}
