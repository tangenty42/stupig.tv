import type { content_preload_config_schema } from '@config/schema'
import type { Connection, Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import type { z } from 'zod'
import { randomUUID } from 'node:crypto'
import { runtime_config } from '@config/loader'
import { db } from '@server/lib/db'
import { create_esa_preload, EsaPreloadError } from '@server/lib/esa-preload'
import { preload_destination } from './preload.repository'

type Options = z.infer<typeof content_preload_config_schema>
type Quota = Awaited<ReturnType<ReturnType<typeof create_esa_preload>['quota']>>
interface Job extends RowDataPacket {
  id: number
  scope_id: number
  attachment_id: number
  object_key: string
  phase: 'queued' | 'submitting' | 'polling'
  task_id: string | null
  submissions: number
  requested_at: Date | null
  age: number | null
}

/** Deliberately conservative: local attempts also cover lagging cloud counters and lost replies. */
export function preload_budget_available(quota: Quota, today: number, recent: number, options: Pick<Options, 'dailyLimit' | 'quotaReserve'>) {
  return Math.max(0, Math.min(options.dailyLimit - today, quota.total - quota.used - today - options.quotaReserve,
    quota.total30 === 0 ? Number.MAX_SAFE_INTEGER : quota.total30 - quota.used30 - recent - options.quotaReserve))
}

/** A site/destination lease serializes external work; publication only writes the ledger. */
export function create_preloader(pool: Pick<Pool, 'execute' | 'getConnection'>, esa: ReturnType<typeof create_esa_preload>,
  destination: { site: string, base: string }, options: Options) {
  const id = preload_destination(destination.site, destination.base)
  async function is_live(connection: Pick<Pool, 'execute'>, job: Job) {
    const key = job.object_key
    const [rows] = await connection.execute<RowDataPacket[]>(`SELECT a.id FROM content_story_attachments a INNER JOIN content_stories s ON s.id = a.story_id
      WHERE a.id = ? AND a.story_id = ? AND a.is_folder = 0 AND a.storage_provider = 'aliyun' AND a.encryption_key IS NULL
      AND (a.object_key = ? OR a.avif_key = ? OR a.jpeg_key = ? OR a.redacted_avif_key = ? OR a.redacted_jpeg_key = ?)
      AND NOT EXISTS (SELECT 1 FROM content_object_retirements r WHERE r.object_key = ?)`,
    [job.attachment_id, job.scope_id, key, key, key, key, key, key])
    return rows.length > 0
  }
  async function transaction<T>(action: (connection: Connection) => Promise<T>) {
    const connection = await pool.getConnection()
    try {
      await connection.beginTransaction()
      const value = await action(connection)
      await connection.commit()
      return value
    }
    catch (error) {
      await connection.rollback()
      throw error
    }
    finally { connection.release() }
  }
  async function sweep(signal?: AbortSignal) {
    if (signal?.aborted)
      return
    const token = randomUUID().replaceAll('-', '')
    const [claim] = await pool.execute<ResultSetHeader>(`UPDATE content_preload_sites SET lease_token = ?, lease_until = TIMESTAMPADD(SECOND, ?, CURRENT_TIMESTAMP(3))
      WHERE destination_id = ? AND next_attempt_at <= CURRENT_TIMESTAMP(3) AND (lease_until IS NULL OR lease_until <= CURRENT_TIMESTAMP(3))`, [token, options.leaseSeconds, id])
    if (! claim.affectedRows)
      return
    let site_error: string | null = null
    async function renew() {
      const [result] = await pool.execute<ResultSetHeader>(`UPDATE content_preload_sites SET lease_until = TIMESTAMPADD(SECOND, ?, CURRENT_TIMESTAMP(3))
        WHERE destination_id = ? AND lease_token = ? AND lease_until > CURRENT_TIMESTAMP(3)`, [options.leaseSeconds, id, token])
      if (! result.affectedRows)
        throw new EsaPreloadError('lease_lost')
    }
    async function checkpoint(job: Job, fields: string, values: (string | number | null)[], delay: number) {
      await pool.execute(`UPDATE content_preload_jobs SET ${fields}, next_attempt_at = TIMESTAMPADD(SECOND, ?, CURRENT_TIMESTAMP(3))
        WHERE id = ? AND destination_id = ? AND EXISTS (SELECT 1 FROM content_preload_sites WHERE destination_id = ? AND lease_token = ? AND lease_until > CURRENT_TIMESTAMP(3))`,
      [... values, delay, job.id, id, id, token])
    }
    try {
      const [jobs] = await pool.execute<Job[]>(`SELECT *, TIMESTAMPDIFF(SECOND, requested_at, CURRENT_TIMESTAMP(3)) AS age FROM content_preload_jobs
        WHERE destination_id = ? AND phase IN ('queued', 'submitting', 'polling') AND next_attempt_at <= CURRENT_TIMESTAMP(3)
        ORDER BY (phase = 'queued'), next_attempt_at, id LIMIT ${options.scanLimit}`, [id])
      let quota: Quota | null = null
      for (const job of jobs) {
        if (signal?.aborted)
          break
        await renew()
        if (job.phase !== 'queued') {
          try {
            if (! job.requested_at)
              throw new EsaPreloadError('invalid_ledger')
            // Lost acknowledgements are reconciled by exact object and request window.
            // Never automatically spend again while the previous task is uncertain.
            const result = await esa.status(destination.base, job.object_key, job.task_id, job.requested_at)
            if (result.status === 'Complete') {
              await checkpoint(job, 'phase = \'completed\', task_id = ?, last_error_code = NULL', [result.task], 0)
            }
            else if (result.status === 'Failed') {
              await checkpoint(job, `phase = ?, task_id = NULL, last_error_code = 'task_failed'`, [job.submissions >= options.maxSubmissions ? 'failed' : 'queued'], options.retrySeconds)
            }
            else {
              await checkpoint(job, 'phase = \'polling\', task_id = ?, last_error_code = ?', [result.task, Number(job.age) >= options.taskTimeoutSeconds ? 'task_unconfirmed' : null],
                Number(job.age) >= options.taskTimeoutSeconds ? options.maxRetrySeconds : options.pollSeconds)
            }
          }
          catch (error) {
            const code = error instanceof EsaPreloadError ? error.code : 'status_failed'
            await checkpoint(job, 'last_error_code = ?', [code], options.maxRetrySeconds)
            if (code === 'permission_denied')
              throw error
          }
          continue
        }
        if (! await is_live(pool, job)) {
          await checkpoint(job, 'phase = \'skipped\', last_error_code = \'object_obsolete\'', [], 0)
          continue
        }
        if (! options.enabled)
          continue
        if (! quota) {
          if (! await esa.tiered())
            throw new EsaPreloadError('tiered_cache_required')
          quota = await esa.quota()
          if (! options.deliveryVerified)
            throw new EsaPreloadError('delivery_unverified')
        }
        const reserved = await transaction(async (connection) => {
          // Match publication/retirement lock ordering. Recheck under the story
          // lock so retirement cannot start between liveness and submission intent.
          await connection.execute('SELECT id FROM content_stories WHERE id = ? FOR UPDATE', [job.scope_id])
          const [lease] = await connection.execute<RowDataPacket[]>(`SELECT destination_id FROM content_preload_sites
            WHERE destination_id = ? AND lease_token = ? AND lease_until > CURRENT_TIMESTAMP(3) FOR UPDATE`, [id, token])
          if (! lease.length)
            throw new EsaPreloadError('lease_lost')
          if (! await is_live(connection, job)) {
            await connection.execute('UPDATE content_preload_jobs SET phase = \'skipped\', last_error_code = \'object_obsolete\' WHERE id = ? AND destination_id = ? AND phase = \'queued\'', [job.id, id])
            return 'obsolete'
          }
          const [counts] = await connection.execute<RowDataPacket[]>(`SELECT
            COALESCE(SUM(IF(budget_date = DATE(CURRENT_TIMESTAMP + INTERVAL 8 HOUR), submissions, 0)), 0) AS today,
            COALESCE(SUM(submissions), 0) AS recent FROM content_preload_budget WHERE destination_id = ?
            AND budget_date >= DATE(CURRENT_TIMESTAMP + INTERVAL 8 HOUR) - INTERVAL 29 DAY`, [id])
          if (! preload_budget_available(quota!, Number(counts[0]?.today ?? 0), Number(counts[0]?.recent ?? 0), options))
            return 'exhausted'
          const [owned] = await connection.execute<ResultSetHeader>(`UPDATE content_preload_jobs SET phase = 'submitting', requested_at = CURRENT_TIMESTAMP(3),
            task_id = NULL, submissions = submissions + 1, last_error_code = NULL WHERE id = ? AND destination_id = ? AND phase = 'queued'`, [job.id, id])
          if (! owned.affectedRows)
            return 'obsolete'
          await connection.execute(`INSERT INTO content_preload_budget (destination_id, budget_date, submissions)
            VALUES (?, DATE(CURRENT_TIMESTAMP + INTERVAL 8 HOUR), 1) ON DUPLICATE KEY UPDATE submissions = submissions + 1`, [id])
          return 'reserved'
        })
        if (reserved === 'obsolete')
          continue
        if (reserved === 'exhausted')
          throw new EsaPreloadError('budget_exhausted')
        try {
          // The committed budget and submitting phase precede the external side effect.
          await renew()
          const task = await esa.submit(destination.base, job.object_key)
          await checkpoint(job, 'phase = \'polling\', task_id = ?, last_error_code = NULL', [task], options.pollSeconds)
        }
        catch (error) {
          const code = error instanceof EsaPreloadError ? error.code : 'submit_unconfirmed'
          if (['quota_exhausted', 'permission_denied', 'queue_full', 'rate_limited'].includes(code)) {
            // Explicit rejection created no cloud task. Keep the conservative
            // daily debit, but allow this object after the site recovers.
            await checkpoint(job, 'phase = \'queued\', submissions = GREATEST(submissions - 1, 0), last_error_code = ?', [code], options.maxRetrySeconds)
            throw error
          }
          // A timeout/invalid receipt might already have created a billable task.
          // Keep its original window; the polling branch, not a blind retry, owns it.
          await checkpoint(job, 'last_error_code = ?', [code], options.retrySeconds)
        }
      }
    }
    catch (error) { site_error = error instanceof EsaPreloadError ? error.code : 'preload_failed' }
    finally {
      await pool.execute(`UPDATE content_preload_sites SET lease_token = NULL, lease_until = NULL, last_error_code = ?,
        next_attempt_at = TIMESTAMPADD(SECOND, ?, CURRENT_TIMESTAMP(3)) WHERE destination_id = ? AND lease_token = ?`,
      [site_error, site_error ? options.maxRetrySeconds : options.sweepIntervalSeconds, id, token])
    }
  }
  return { sweep }
}

export async function sweep_preloads(signal?: AbortSignal) {
  const { app, aliyun } = runtime_config()
  if (! aliyun.esa || ! aliyun.esaPurge?.siteId || ! aliyun.esaPurge.accessKeyId || ! aliyun.esaPurge.accessKeySecret)
    return
  // Disabling new submissions must not abandon polling or retirement barriers.
  await create_preloader(db, create_esa_preload(aliyun.esaPurge), { site: aliyun.esaPurge.siteId, base: aliyun.esa.baseUrl }, app.contentPreload).sweep(signal)
}
