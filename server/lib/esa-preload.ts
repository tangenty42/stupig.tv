import type OpenApiClass from '@alicloud/openapi-client'
import type { aliyun_esa_purge_config_schema } from '@config/schema'
import type { z } from 'zod'
import OpenApiModule, { Config, OpenApiRequest, Params } from '@alicloud/openapi-client'
import { RuntimeOptions } from '@alicloud/tea-util'
import { runtime_config } from '@config/loader'
import { retirement_url } from './esa-purge'

function wrapped_default(value: unknown): value is { default: typeof OpenApiClass } {
  return typeof value === 'object' && value !== null && 'default' in value
}
const OpenApi = wrapped_default(OpenApiModule) ? OpenApiModule.default : OpenApiModule as unknown as typeof OpenApiClass

export class EsaPreloadError extends Error {
  constructor(readonly code: string) { super(code) }
}
function count(value: unknown) {
  if ((typeof value !== 'string' && typeof value !== 'number') || ! /^\d+$/.test(String(value)) || ! Number.isSafeInteger(Number(value)))
    throw new EsaPreloadError('invalid_response')
  return Number(value)
}

/** The management client never accepts browser URLs, signatures or a different site. */
export function create_esa_preload(config: z.infer<typeof aliyun_esa_purge_config_schema> | null = runtime_config().aliyun.esaPurge,
  clock_skew_seconds = runtime_config().app.contentPreload.taskClockSkewSeconds) {
  if (! config?.siteId || ! config.accessKeyId || ! config.accessKeySecret)
    throw new EsaPreloadError('not_configured')
  const destination = config
  const client = new OpenApi(new Config(destination))
  async function call(action: string, query: Record<string, string> = {}) {
    let response
    try {
      response = await client.callApi(new Params({ action, version: '2024-09-10', protocol: 'HTTPS', pathname: '/',
        method: action === 'PreloadCaches' ? 'POST' : 'GET', authType: 'AK', style: 'RPC', reqBodyType: 'formData', bodyType: 'json' }),
      new OpenApiRequest({ query: { SiteId: destination.siteId, ... query } }),
      new RuntimeOptions({ autoretry: false, readTimeout: destination.timeoutMs, connectTimeout: destination.timeoutMs }))
    }
    catch (error) {
      const code = String((error as { code?: string }).code ?? '')
      throw new EsaPreloadError(code.startsWith('Forbidden') || code.startsWith('AccessDenied')
        ? 'permission_denied'
        : code === 'QuotaExceeded' ? 'quota_exhausted' : code === 'PreloadQueueFull' ? 'queue_full' : code === 'TooManyRequests' ? 'rate_limited' : 'request_failed')
    }
    if (response.statusCode !== 200 || ! response.body || typeof response.body !== 'object')
      throw new EsaPreloadError('invalid_response')
    return response.body as Record<string, unknown>
  }
  async function quota() {
    const body = await call('GetPurgeQuota', { Type: 'preload' })
    return { total: count(body.Quota), used: count(body.Usage), total30: count(body.Quota30Day), used30: count(body.Usage30Day) }
  }
  async function tiered() {
    const body = await call('GetTieredCache')
    if (! ['edge', 'edge_smart', 'edge_regional', 'edge_regional_smart'].includes(String(body.CacheArchitectureMode)))
      throw new EsaPreloadError('invalid_response')
    return body.CacheArchitectureMode !== 'edge'
  }
  async function submit(base: string, key: string) {
    const body = await call('PreloadCaches', { Content: JSON.stringify([retirement_url(base, key)]) })
    if (typeof body.TaskId !== 'string' || ! /^[\w-]{1,128}$/.test(body.TaskId))
      throw new EsaPreloadError('invalid_response')
    return body.TaskId
  }
  async function status(base: string, key: string, task: string | null, since: Date, now = new Date()) {
    const url = retirement_url(base, key)
    const iso = (date: Date) => date.toISOString().replace(/\.\d{3}Z$/, 'Z')
    // A receipt's exact task ID is authoritative. Cloud creation timestamps can
    // precede our committed request intent because their clocks differ.
    const window: Record<string, string> = task
      ? {}
      : {
          StartTime: iso(new Date(since.getTime() - clock_skew_seconds * 1000)),
          EndTime: iso(new Date(now.getTime() + clock_skew_seconds * 1000)),
        }
    const candidates = new Map<string, Record<string, unknown>>()
    function resolved(entry: Record<string, unknown>) {
      if (! ['Complete', 'Refreshing', 'Failed'].includes(String(entry.Status)) || typeof entry.TaskId !== 'string' || ! /^[\w-]{1,128}$/.test(entry.TaskId))
        throw new EsaPreloadError('invalid_response')
      return { status: entry.Status as 'Complete' | 'Refreshing' | 'Failed', task: entry.TaskId }
    }
    for (let page = 1; page <= 20; page ++) {
      const body = await call('DescribePreloadTasks', { Content: url, PageNumber: String(page), PageSize: '50',
        ... window })
      if (! Array.isArray(body.Tasks))
        throw new EsaPreloadError('invalid_response')
      const total = count(body.TotalCount)
      for (const entry of body.Tasks as Record<string, unknown>[]) {
        if (entry.Content !== url)
          continue
        if (task && entry.TaskId === task)
          return resolved(entry)
        if (! task) {
          const value = resolved(entry)
          candidates.set(value.task, entry)
        }
      }
      if (page * 50 >= total) {
        if (candidates.size > 1)
          throw new EsaPreloadError('task_ambiguous')
        if (candidates.size === 1)
          return resolved([... candidates.values()][0]!)
        return { status: 'Missing' as const, task }
      }
    }
    throw new EsaPreloadError('history_limit')
  }
  return { quota, tiered, submit, status }
}
