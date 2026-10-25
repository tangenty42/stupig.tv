import type { create_esa_preload } from '@server/lib/esa-preload'
import type { Pool } from 'mysql2/promise'
import { expect, it, vi } from 'vitest'

vi.mock('@config/loader', () => ({ runtime_config: vi.fn() }))
vi.mock('@server/lib/db', () => ({ db: {} }))
const { create_preloader, preload_budget_available } = await import('./preload.service')
const { EsaPreloadError } = await import('@server/lib/esa-preload')
const options = { enabled: true, deliveryVerified: true, sweepIntervalSeconds: 30, scanLimit: 5, leaseSeconds: 300,
  retrySeconds: 300, maxRetrySeconds: 3600, pollSeconds: 30, taskTimeoutSeconds: 3600, taskClockSkewSeconds: 60, dailyLimit: 500, quotaReserve: 1000, maxSubmissions: 3, maxObjectBytes: 20971520 }
const destination = { site: '123', base: 'https://edge.example.test' }
const quota = { total: 10000, used: 0, total30: 0, used30: 0 }

// Substitute only SQL/ESA boundaries. The worker, budgets, ordering and fences
// run unchanged; real MySQL verification additionally checks the SQL contracts.
function fixture() {
  let now = Date.now()
  const job = { id: 1, scope_id: 7, attachment_id: 8, object_key: 'content/att/image.avif', phase: 'queued',
    task_id: null as string | null, requested_at: null as Date | null, submissions: 0, age: 0, next: 0, error: null as string | null }
  const state = { job, token: null as string | null, until: 0, next: 0, error: null as string | null, budget: 0, live: true }
  const esa = {
    quota: vi.fn(async () => quota), tiered: vi.fn(async () => true), submit: vi.fn(async () => 'task'),
    status: vi.fn<ReturnType<typeof create_esa_preload>['status']>(async () => ({ status: 'Complete', task: 'task' })),
  }
  const execute = vi.fn(async (sql: string, args: unknown[] = []): Promise<unknown[]> => {
    if (sql.startsWith('UPDATE content_preload_sites SET lease_token = ?')) {
      if (state.next > now || (state.token && state.until > now))
        return [{ affectedRows: 0 }]
      state.token = String(args[0])
      state.until = now + Number(args[1]) * 1000
    }
    else if (sql.startsWith('UPDATE content_preload_sites SET lease_until')) {
      if (state.token !== args[2] || state.until <= now)
        return [{ affectedRows: 0 }]
      state.until = now + Number(args[0]) * 1000
    }
    else if (sql.startsWith('UPDATE content_preload_sites SET lease_token = NULL')) {
      if (state.token !== args[3])
        return [{ affectedRows: 0 }]
      state.token = null
      state.error = args[0] as string | null
      state.next = now + Number(args[1]) * 1000
    }
    else if (sql.startsWith('SELECT destination_id FROM content_preload_sites')) {
      return [state.token === args[1] && state.until > now ? [{}] : []]
    }
    else if (sql.startsWith('SELECT id FROM content_stories')) {
      return [[{ id: 7 }]]
    }
    else if (sql.includes('FROM content_preload_jobs')) {
      return [job.next <= now && ['queued', 'submitting', 'polling'].includes(job.phase) ? [structuredClone(job)] : []]
    }
    else if (sql.includes('FROM content_story_attachments')) {
      return [state.live ? [{ id: 8 }] : []]
    }
    else if (sql.includes('FROM content_preload_budget')) {
      return [[{ today: state.budget, recent: state.budget }]]
    }
    else if (sql.startsWith('INSERT INTO content_preload_budget')) {
      state.budget ++
    }
    else if (sql.startsWith('UPDATE content_preload_jobs SET phase = \'submitting\'')) {
      job.phase = 'submitting'
      job.submissions ++
      job.requested_at = new Date(now)
      job.task_id = null
    }
    else if (sql.startsWith('UPDATE content_preload_jobs SET phase = \'skipped\'') && args.length === 2) {
      job.phase = 'skipped'
      job.error = 'object_obsolete'
    }
    else if (sql.startsWith('UPDATE content_preload_jobs')) {
      if (state.token !== args.at(- 1) || state.until <= now)
        return [{ affectedRows: 0 }]
      const values = args.slice(0, - 5)
      if (sql.includes('phase = ?')) {
        job.phase = String(values[0])
      }
      else {
        const phase = /phase = '(\w+)'/.exec(sql)?.[1]
        if (phase)
          job.phase = phase
      }
      if (sql.includes('task_id = ?'))
        job.task_id = values[0] as string | null
      if (sql.includes('task_id = NULL'))
        job.task_id = null
      if (sql.includes('submissions = GREATEST'))
        job.submissions --
      job.error = sql.includes('last_error_code = ?') ? values.at(- 1) as string | null : /last_error_code = '(\w+)'/.exec(sql)?.[1] ?? null
      job.next = now + Number(args.at(- 5)) * 1000
    }
    else { throw new Error(`Unhandled SQL: ${sql}`) }
    return [{ affectedRows: 1 }]
  })
  const connection = { execute, beginTransaction: vi.fn(), commit: vi.fn(), rollback: vi.fn(), release: vi.fn() }
  const pool = { execute, getConnection: async () => connection } as unknown as Pool
  return { state, esa, execute, service: (overrides = {}) => create_preloader(pool, esa, destination, { ... options, ... overrides }),
    advance(seconds: number) {
      now += seconds * 1000
      job.age += seconds
    } }
}

it('budgets conservatively for daily, 30-day, local and reserved capacity', () => {
  expect(preload_budget_available(quota, 0, 0, options)).toBe(500)
  expect(preload_budget_available(quota, 500, 500, options)).toBe(0)
  expect(preload_budget_available({ ... quota, used: 9000 }, 0, 0, options)).toBe(0)
  expect(preload_budget_available({ ... quota, total30: 2000, used30: 900 }, 1, 101, options)).toBe(0)
  expect(preload_budget_available({ ... quota, used: 8990 }, 9, 9, options)).toBe(1)
})

it('stops before claiming a site on shutdown and preserves an in-flight receipt checkpoint', async () => {
  const f = fixture()
  const controller = new AbortController()
  controller.abort()
  await f.service().sweep(controller.signal)
  expect(f.execute).not.toHaveBeenCalled()
  const active = new AbortController()
  f.esa.submit.mockImplementation(async () => {
    active.abort()
    return 'task'
  })
  await f.service().sweep(active.signal)
  expect(f.state.job).toMatchObject({ phase: 'polling', task_id: 'task' })
})

it('commits a budget and submission intent before calling ESA and polls the receipt to completion', async () => {
  const f = fixture()
  f.esa.submit.mockImplementation(async () => {
    expect(f.state.budget).toBe(1)
    expect(f.state.job.phase).toBe('submitting')
    expect(f.state.job.requested_at).toBeInstanceOf(Date)
    return 'task'
  })
  await f.service().sweep()
  expect(f.state.job).toMatchObject({ phase: 'polling', task_id: 'task', submissions: 1 })
  f.advance(30)
  await f.service().sweep()
  expect(f.state.job.phase).toBe('completed')
  f.advance(30)
  await f.service().sweep()
  expect(f.esa.submit).toHaveBeenCalledOnce()
})

it('allows only one worker to spend while an external submission is in flight', async () => {
  const f = fixture()
  let release!: (task: string) => void
  let entered!: () => void
  const submitting = new Promise<void>((resolve) => {
    entered = resolve
  })
  f.esa.submit.mockImplementation(() => {
    entered()
    return new Promise(resolve => release = resolve)
  })
  const first = f.service().sweep()
  await submitting
  await f.service().sweep()
  expect(f.state.budget).toBe(1)
  expect(f.esa.submit).toHaveBeenCalledOnce()
  release('task')
  await first
})

it.each([['deliveryVerified', false, 'delivery_unverified'], ['enabled', false, null]] as const)('does not spend when %s is false', async (field, value, error) => {
  const f = fixture()
  await f.service({ [field]: value }).sweep()
  expect(f.esa.submit).not.toHaveBeenCalled()
  expect(f.state.budget).toBe(0)
  expect(f.state.error).toBe(error)
})

it('does not submit with single-tier cache, exhausted quota or missing management permission', async () => {
  const f = fixture()
  f.esa.tiered.mockResolvedValue(false)
  await f.service().sweep()
  expect(f.state.error).toBe('tiered_cache_required')
  f.advance(3600)
  f.esa.tiered.mockResolvedValue(true)
  f.esa.quota.mockResolvedValue({ ... quota, used: 10000 })
  await f.service().sweep()
  expect(f.state.error).toBe('budget_exhausted')
  f.advance(3600)
  f.esa.quota.mockRejectedValue(new EsaPreloadError('permission_denied'))
  await f.service().sweep()
  expect(f.state.error).toBe('permission_denied')
  expect(f.state.job.phase).toBe('queued')
  expect(f.esa.submit).not.toHaveBeenCalled()
  expect(f.state.budget).toBe(0)
})

it('reconciles an ambiguous submission after restart instead of spending twice', async () => {
  const f = fixture()
  f.esa.submit.mockRejectedValue(new EsaPreloadError('request_failed'))
  await f.service().sweep()
  expect(f.state.job.phase).toBe('submitting')
  const since = f.state.job.requested_at
  f.advance(300)
  await f.service().sweep()
  expect(f.esa.status).toHaveBeenCalledWith(destination.base, f.state.job.object_key, null, since)
  expect(f.state.job.phase).toBe('completed')
  expect(f.esa.submit).toHaveBeenCalledOnce()
  expect(f.state.budget).toBe(1)
})

it('keeps unconfirmed tasks behind the retirement barrier even after the normal task timeout', async () => {
  const f = fixture()
  await f.service().sweep()
  f.advance(7200)
  f.esa.status.mockResolvedValue({ status: 'Missing', task: 'task' })
  await f.service().sweep()
  expect(f.state.job).toMatchObject({ phase: 'polling', error: 'task_unconfirmed' })
  expect(f.esa.submit).toHaveBeenCalledOnce()
})

it('can retry an explicitly rejected request after permissions recover', async () => {
  const f = fixture()
  f.esa.submit.mockRejectedValueOnce(new EsaPreloadError('permission_denied'))
  await f.service().sweep()
  expect(f.state.job).toMatchObject({ phase: 'queued', submissions: 0, error: 'permission_denied' })
  f.advance(3600)
  await f.service().sweep()
  expect(f.esa.submit).toHaveBeenCalledTimes(2)
  expect(f.state.job.phase).toBe('polling')
})

it('retries confirmed failures only up to the configured number of submissions', async () => {
  const f = fixture()
  await f.service().sweep()
  f.state.job.submissions = options.maxSubmissions
  f.advance(30)
  f.esa.status.mockResolvedValue({ status: 'Failed', task: 'task' })
  await f.service().sweep()
  expect(f.state.job.phase).toBe('failed')
  expect(f.esa.submit).toHaveBeenCalledOnce()
})

it('skips removed/replaced objects but still polls accepted tasks when new submissions are disabled', async () => {
  const f = fixture()
  f.state.live = false
  await f.service().sweep()
  expect(f.state.job.phase).toBe('skipped')
  expect(f.esa.submit).not.toHaveBeenCalled()
  Object.assign(f.state.job, { phase: 'polling', task_id: 'task', requested_at: new Date() })
  f.advance(30)
  await f.service({ enabled: false }).sweep()
  expect(f.state.job.phase).toBe('completed')
  expect(f.esa.status).toHaveBeenCalledOnce()
})

it('rechecks liveness after acquiring the story lock before committing a submission', async () => {
  const f = fixture()
  f.esa.quota.mockImplementation(async () => {
    f.state.live = false
    return quota
  })
  await f.service().sweep()
  expect(f.state.job.phase).toBe('skipped')
  expect(f.state.budget).toBe(0)
  expect(f.esa.submit).not.toHaveBeenCalled()
})
