/** @deprecated Content plugins now register with the unified background runner. */
export function start_image_scheduler(sweep: () => Promise<void>, interval_seconds: number, on_error: (error: unknown) => void) {
  let running: Promise<void> | null = null
  let closed = false
  const tick = () => {
    if (running || closed)
      return
    running = sweep().catch(on_error).finally(() => {
      running = null
    })
  }
  const timer = setInterval(tick, interval_seconds * 1000)
  timer.unref()
  tick()
  return async () => {
    closed = true
    clearInterval(timer)
    await running
  }
}
