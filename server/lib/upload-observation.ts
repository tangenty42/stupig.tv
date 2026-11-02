import { AsyncLocalStorage } from 'node:async_hooks'
import { performance } from 'node:perf_hooks'
import { log_info } from './log'

const stages = ['upload_seal', 'multipart_complete', 'upload_adopt', 'upload_adopt_commit', 'image_claim', 'image_queue', 'image_job', 'image_source_guard', 'image_source_info', 'image_display', 'image_fallback', 'image_lqip', 'image_final_guard', 'image_archive', 'image_ready_commit', 'sync_queue', 'sync_publish_ack', 'db_acquire'] as const
type Stage = typeof stages[number]
interface Identity { session_id?: string, job_id?: string, execution_epoch?: number }
interface Span { parent?: Span, db_acquire_ms: number, db_acquisitions: number }
interface Context { identity: Identity, span?: Span }
interface Summary { count: number, failed: number, active: number, peak_active: number, total_ms: number, max_ms: number, recent: number[] }
const round = (value: number) => Math.round(value * 100) / 100

/** Fixed dimensions and a bounded recent sample; identities exist only in logs/context. */
export function create_upload_observer(now = () => performance.now(), emit: typeof log_info = (message, fields) => log_info(message, fields)) {
  const context = new AsyncLocalStorage<Context>()
  const summaries = new Map<Stage, Summary>()
  function identity(input: Identity = {}) {
    const safe: Identity = {}
    for (const key of ['session_id', 'job_id'] as const) {
      if (typeof input[key] === 'string' && /^[\da-f]{32}$/.test(input[key]))
        safe[key] = input[key]
    }
    if (Number.isSafeInteger(input.execution_epoch) && input.execution_epoch! > 0)
      safe.execution_epoch = input.execution_epoch
    return safe
  }
  function summary(stage: Stage) {
    let value = summaries.get(stage)
    if (! value) {
      value = { count: 0, failed: 0, active: 0, peak_active: 0, total_ms: 0, max_ms: 0, recent: [] }
      summaries.set(stage, value)
    }
    return value
  }
  function record(stage: Stage, duration: number, failed = false) {
    if (! Number.isFinite(duration) || duration < 0)
      return
    const value = summary(stage)
    value.count ++
    value.failed += Number(failed)
    value.total_ms += duration
    value.max_ms = Math.max(value.max_ms, duration)
    value.recent.push(duration)
    if (value.recent.length > 128)
      value.recent.shift()
  }
  function log(stage: Stage, duration: number, failed: boolean, fields: Identity, span?: Span) {
    try {
      emit('upload_stage', { stage, outcome: failed ? 'failed' : 'returned', duration_ms: round(duration), ... fields,
        ... (span ? { db_acquire_ms: round(span.db_acquire_ms), db_acquisitions: span.db_acquisitions } : {}) })
    }
    catch { /* Diagnostics must not turn a committed operation into a failure. */ }
  }
  async function measure<T>(stage: Stage, action: () => Promise<T>, fields: Identity = {}): Promise<T> {
    const parent = context.getStore()
    const current = { identity: { ... parent?.identity, ... identity(fields) }, span: { parent: parent?.span, db_acquire_ms: 0, db_acquisitions: 0 } }
    const value = summary(stage)
    value.active ++
    value.peak_active = Math.max(value.peak_active, value.active)
    const started = now()
    let failed = false
    try {
      return await context.run(current, action)
    }
    catch (error) {
      failed = true
      throw error
    }
    finally {
      const duration = Math.max(0, now() - started)
      value.active --
      record(stage, duration, failed)
      log(stage, duration, failed, current.identity, current.span)
    }
  }
  function duration(stage: Stage, elapsed: number, fields: Identity = {}) {
    if (! Number.isFinite(elapsed) || elapsed < 0)
      return
    record(stage, elapsed)
    log(stage, elapsed, false, { ... context.getStore()?.identity, ... identity(fields) })
  }
  function database_wait() {
    // Capture at request time: a queued callback may execute in a releasing caller's context.
    const parent = context.getStore()?.span
    const value = summary('db_acquire')
    value.active ++
    value.peak_active = Math.max(value.peak_active, value.active)
    const started = now()
    let done = false
    return (failed = false) => {
      if (done)
        return
      done = true
      const elapsed = Math.max(0, now() - started)
      value.active --
      record('db_acquire', elapsed, failed)
      for (let span = parent; span; span = span.parent) {
        span.db_acquire_ms += elapsed
        span.db_acquisitions ++
      }
    }
  }
  function snapshot() {
    return stages.filter(stage => summaries.has(stage)).map((stage) => {
      const { recent, ... value } = summary(stage)
      const sorted = [... recent].sort((a, b) => a - b)
      const percentile = (p: number) => sorted.length ? round(sorted[Math.ceil(sorted.length * p) - 1]!) : null
      return { stage, ... value, total_ms: round(value.total_ms), max_ms: round(value.max_ms), recent_count: recent.length,
        recent_p50_ms: percentile(0.5), recent_p95_ms: percentile(0.95) }
    })
  }
  function with_context<T>(fields: Identity, action: () => Promise<T>): Promise<T> {
    // Request/task boundary, not a child span: a wakeup must not charge the
    // triggering HTTP request for another background task's connections.
    return context.run({ identity: identity(fields) }, action)
  }
  return { measure, duration, database_wait, snapshot, with_context }
}

const observer = create_upload_observer()
export const observe_upload = observer.measure
export const record_upload_duration = observer.duration
export const observe_database_wait = observer.database_wait
export const upload_observation_snapshot = observer.snapshot
export const with_upload_context = observer.with_context

export function upload_process_resources() {
  const memory = process.memoryUsage()
  const cpu = process.cpuUsage()
  return { uptime_seconds: round(process.uptime()), rss_bytes: memory.rss, heap_used_bytes: memory.heapUsed,
    external_bytes: memory.external, cpu_user_ms: round(cpu.user / 1000), cpu_system_ms: round(cpu.system / 1000) }
}
