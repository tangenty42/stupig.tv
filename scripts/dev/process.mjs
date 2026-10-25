import { spawn } from 'node:child_process'

/** Own only children launched here; stopping must also cancel pending restarts. */
export function supervise_child(command, args, options = {}) {
  const launch = options.spawn ?? spawn
  let child
  let retry
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
