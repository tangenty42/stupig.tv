import { runtime_config } from '@config/loader'
import { create_esa_preload, EsaPreloadError } from '@server/lib/esa-preload'
import { preload_destination } from '@server/services/content/preload.repository'

// Standalone diagnostics default to the development layer, like the dev tools.
// Set NODE_ENV explicitly when inspecting a separately provisioned production env.
process.env.NODE_ENV ??= 'development'
const { db } = await import('@server/lib/db')
const { app, aliyun } = runtime_config()
const credentials = aliyun.esaPurge
try {
  if (! credentials?.siteId || ! aliyun.esa)
    throw new EsaPreloadError('not_configured')
  if (process.argv.includes('--policy')) {
    console.log(JSON.stringify({ Version: '1', Statement: [{ Effect: 'Allow', Action: [
      'esa:PurgeCaches', 'esa:DescribePurgeTasks',
      'esa:PreloadCaches', 'esa:DescribePreloadTasks', 'esa:GetPurgeQuota', 'esa:GetTieredCache',
    ], Resource: [`acs:esa:${credentials.regionId}:*:site/${credentials.siteId}`] }] }, null, 2))
  }
  else {
    const client = create_esa_preload(credentials)
    const [quota, tiered] = await Promise.all([client.quota(), client.tiered()])
    const destination = preload_destination(credentials.siteId, aliyun.esa.baseUrl)
    const [jobs] = await db.execute('SELECT phase, COUNT(*) AS count FROM content_preload_jobs WHERE destination_id = ? GROUP BY phase', [destination])
    const [state] = await db.execute('SELECT last_error_code, next_attempt_at FROM content_preload_sites WHERE destination_id = ?', [destination])
    console.log(JSON.stringify({ enabled: app.contentPreload.enabled, deliveryVerified: app.contentPreload.deliveryVerified,
      tiered, quota, dailyLimit: app.contentPreload.dailyLimit, reserve: app.contentPreload.quotaReserve, jobs, state }))
  }
}
catch (error) {
  console.error(JSON.stringify({ error: error instanceof EsaPreloadError ? error.code : 'preload_check_failed' }))
  process.exitCode = 1
}
finally { await db.end() }
