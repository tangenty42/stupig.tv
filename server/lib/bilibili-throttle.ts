import { randomUUID } from 'node:crypto'
import { error_fields, log_warn } from './log'

interface GateRedis {
  get: (key: string) => Promise<string | null>
  set: (key: string, value: string, expiry: 'PX', ms: number, mode: 'NX') => Promise<string | null>
  eval: (script: string, keys: number, ... args: (string | number)[]) => Promise<unknown>
}
interface Backoff { failures: number, retry_at: number }
interface Options {
  fetchTimeoutMs: number
  fetchFailureCooldownMs: number
  fetchFailureMaxCooldownMs: number
  retryJitterRatio: number
}
const state_key = 'bilibili:upstream:backoff'
const probe_key = 'bilibili:upstream:probe'
// A timed-out/expired owner must never clear another process's cooldown/lease.
const finish_probe = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
if ARGV[2] == '' then redis.call('DEL', KEYS[2])
else redis.call('SET', KEYS[2], ARGV[2]) end
redis.call('DEL', KEYS[1])
return 1`

/** One queue per process, one probe across replicas, durable backoff across restarts. */
export function create_bilibili_throttle(client: GateRedis, options: Options) {
  let local: Backoff = { failures: 0, retry_at: 0 }
  let tail = Promise.resolve()
  function cool_down() {
    local.failures = Math.min(local.failures + 1, 64)
    const delay = Math.min(options.fetchFailureMaxCooldownMs, options.fetchFailureCooldownMs * 2 ** (local.failures - 1))
    // Positive jitter never shortens the base delay or exceeds the six-hour cap.
    local.retry_at = Date.now() + Math.min(options.fetchFailureMaxCooldownMs, Math.round(delay * (1 + Math.random() * options.retryJitterRatio)))
    log_warn('bilibili upstream cooldown', { failures: local.failures, retry_at: new Date(local.retry_at).toISOString() })
  }
  async function read_backoff() {
    const raw = await client.get(state_key)
    if (! raw) {
      local = { failures: 0, retry_at: 0 }
      return
    }
    const state = JSON.parse(raw) as Backoff
    if (! Number.isSafeInteger(state.failures) || state.failures < 0 || ! Number.isSafeInteger(state.retry_at) || state.retry_at < 0)
      throw new Error('Invalid Bilibili upstream backoff state')
    local = state
  }
  function run<T>(work: (mark_risk: () => void) => Promise<T>, fallback: () => T): Promise<T> {
    const job = tail.then(async () => {
      if (local.retry_at > Date.now())
        return fallback()
      const token = randomUUID()
      let acquired = false
      try {
        await read_backoff()
        if (local.retry_at > Date.now())
          return fallback()
        // At most short redirect + API + watch-page timeout, plus one budget
        // for cache writes and finalization. A crash releases the lease by TTL.
        acquired = await client.set(probe_key, token, 'PX', options.fetchTimeoutMs * 4, 'NX') === 'OK'
        if (! acquired)
          return fallback()
        await read_backoff()
      }
      catch (error) {
        // Fail closed when the shared gate is unavailable: do not let a Redis
        // outage turn every web request into a new request to Bilibili.
        cool_down()
        log_warn('bilibili upstream gate unavailable', error_fields(error))
        if (acquired) {
          try {
            await client.eval(finish_probe, 2, probe_key, state_key, token, JSON.stringify(local))
          }
          catch {
            // Lease expiry still releases a failed owner.
          }
        }
        return fallback()
      }
      let risk = false
      try {
        if (local.retry_at > Date.now())
          return fallback()
        const result = await work(() => {
          risk = true
        })
        if (risk)
          cool_down()
        else
          local = { failures: 0, retry_at: 0 }
        return result
      }
      catch (error) {
        cool_down()
        throw error
      }
      finally {
        try {
          await client.eval(finish_probe, 2, probe_key, state_key, token, local.failures ? JSON.stringify(local) : '')
        }
        catch (error) {
          cool_down()
          log_warn('bilibili upstream gate finalization failed', error_fields(error))
        }
      }
    })
    tail = job.then(() => {}, () => {})
    return job
  }
  return { run }
}
