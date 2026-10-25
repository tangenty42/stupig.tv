export interface BackgroundAdapter {
  id: string
  intervalSeconds: number
  /** Per-process concurrent sweep slots, not HTTP request or cluster limits. */
  resources: Record<string, number>
  sweep: (signal: AbortSignal) => Promise<void>
}

interface Entry {
  adapter: BackgroundAdapter
  controller: AbortController
  timer: ReturnType<typeof setInterval>
  phase: 'idle' | 'queued' | 'running'
  started: number | null
  finished: number | null
  runs: number
  failures: number
  error: 'sweep_failed' | 'shutdown_timeout' | null
  active: Promise<void> | null
}

/** Execution shell only. Domain adapters still own durable claims and checkpoints. */
export function create_background_runner(options: { shutdownTimeoutMs: number, resources: Record<string, number> },
  report: (id: string, code: 'sweep_failed' | 'shutdown_timeout') => void) {
  if (! Number.isSafeInteger(options.shutdownTimeoutMs) || options.shutdownTimeoutMs <= 0
    || Object.values(options.resources).some(value => ! Number.isSafeInteger(value) || value <= 0)) {
    throw new Error('Invalid background runner limits')
  }
  const entries = new Map<string, Entry>()
  const used = Object.fromEntries(Object.keys(options.resources).map(key => [key, 0]))
  const queue: Entry[] = []
  let closed = false
  let closing: Promise<{ timed_out: string[] }> | null = null

  function drain() {
    if (closed)
      return
    const blocked = new Set<string>()
    for (let index = 0; index < queue.length;) {
      const entry = queue[index]!
      const resources = Object.entries(entry.adapter.resources)
      if (resources.some(([key, weight]) => blocked.has(key) || used[key]! + weight > options.resources[key]!)) {
        resources.forEach(([key]) => blocked.add(key))
        index ++
        continue
      }
      queue.splice(index, 1)
      resources.forEach(([key, weight]) => used[key]! += weight)
      entry.phase = 'running'
      entry.started = Date.now()
      entry.runs ++
      // Keep slots until the actual promise settles, including after shutdown
      // times out. Releasing them early would hide still-running work.
      entry.active = Promise.resolve().then(async () => {
        if (! entry.controller.signal.aborted)
          await entry.adapter.sweep(entry.controller.signal)
        entry.error = null
      }).catch(() => {
        entry.failures ++
        entry.error = 'sweep_failed'
        report(entry.adapter.id, 'sweep_failed')
      }).finally(() => {
        entry.finished = Date.now()
        entry.phase = 'idle'
        entry.active = null
        resources.forEach(([key, weight]) => used[key]! -= weight)
        drain()
      })
    }
  }
  function register(adapter: BackgroundAdapter) {
    if (closed || entries.has(adapter.id) || ! /^[a-z][\w-]*$/.test(adapter.id)
      || ! Number.isFinite(adapter.intervalSeconds) || adapter.intervalSeconds <= 0
      || Object.entries(adapter.resources).some(([key, weight]) => ! Number.isSafeInteger(weight) || weight <= 0 || ! options.resources[key] || weight > options.resources[key]!)) {
      throw new Error('Invalid or duplicate background adapter')
    }
    let entry!: Entry
    const tick = () => {
      if (closed || entry.phase !== 'idle')
        return
      entry.phase = 'queued'
      queue.push(entry)
      drain()
    }
    const timer = setInterval(tick, adapter.intervalSeconds * 1000)
    timer.unref()
    entry = { adapter, timer, controller: new AbortController(), phase: 'idle', started: null, finished: null, runs: 0, failures: 0, error: null, active: null }
    entries.set(adapter.id, entry)
    tick()
  }
  function snapshot() {
    return { closed, resources: Object.fromEntries(Object.entries(options.resources).map(([key, capacity]) => [key, { capacity, used: used[key]! }])),
      adapters: [... entries.values()].map(entry => ({ id: entry.adapter.id, phase: entry.phase, runs: entry.runs, failures: entry.failures,
        last_error_code: entry.error, last_duration_ms: entry.started !== null && entry.finished !== null && entry.finished >= entry.started ? entry.finished - entry.started : null,
        last_started_at: entry.started === null ? null : new Date(entry.started).toISOString(),
        last_finished_at: entry.finished === null ? null : new Date(entry.finished).toISOString() })) }
  }
  function close() {
    if (closing)
      return closing
    closed = true
    for (const entry of entries.values()) {
      clearInterval(entry.timer)
      entry.controller.abort()
      if (entry.phase === 'queued')
        entry.phase = 'idle'
    }
    queue.length = 0
    closing = (async () => {
      let timer!: ReturnType<typeof setTimeout>
      const deadline = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, options.shutdownTimeoutMs)
      })
      try {
        await Promise.race([Promise.allSettled([... entries.values()].flatMap(entry => entry.active ? [entry.active] : [])), deadline])
      }
      finally { clearTimeout(timer) }
      const timed_out = [... entries.values()].filter(entry => entry.active).map(entry => entry.adapter.id)
      timed_out.forEach((id) => {
        entries.get(id)!.error = 'shutdown_timeout'
        report(id, 'shutdown_timeout')
      })
      return { timed_out }
    })()
    return closing
  }
  return { register, snapshot, close }
}
