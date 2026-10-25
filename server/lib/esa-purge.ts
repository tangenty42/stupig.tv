import type OpenApiClass from '@alicloud/openapi-client'
import type { aliyun_esa_purge_config_schema } from '@config/schema'
import type { z } from 'zod'
import OpenApiModule, { Config, OpenApiRequest, Params } from '@alicloud/openapi-client'
import { RuntimeOptions } from '@alicloud/tea-util'
import { runtime_config } from '@config/loader'
import { ApiError } from '@server/errors/ApiError'

function wrapped_default(value: unknown): value is { default: typeof OpenApiClass } {
  return typeof value === 'object' && value !== null && 'default' in value
}
const OpenApi = wrapped_default(OpenApiModule) ? OpenApiModule.default : OpenApiModule as unknown as typeof OpenApiClass

/** The canonical URL matches ESA's query-free shared object cache. Never purge a signed URL. */
export function retirement_url(base: string, key: string) {
  const origin = new URL(base)
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/'
    || ! key.startsWith('content/att/') || /[\\?\0\r\n]/.test(key) || key.split('/').some(part => ! part || part === '.' || part === '..')) {
    throw new ApiError(400, '退役对象地址无效')
  }
  return new URL(`/${key.split('/').map(encodeURIComponent).join('/')}`, origin).href
}

/** Only the two site-scoped management APIs; no domain/directory/all-site purge. */
export function create_esa_purge(config: z.infer<typeof aliyun_esa_purge_config_schema> | null = runtime_config().aliyun.esaPurge) {
  if (! config?.accessKeyId || ! config.accessKeySecret || ! config.siteId)
    throw new ApiError(503, 'ESA 缓存刷新尚未配置')
  const destination = config
  const client = new OpenApi(new Config(destination))
  async function call(action: 'PurgeCaches' | 'DescribePurgeTasks', query: Record<string, string>) {
    // Error objects may carry signed requests/credentials. Persist only the
    // operation's safe code in the retirement ledger, never the SDK error.
    try {
      const response = await client.callApi(new Params({
        action, version: '2024-09-10', protocol: 'HTTPS', pathname: '/',
        method: action === 'PurgeCaches' ? 'POST' : 'GET', authType: 'AK', style: 'RPC', reqBodyType: 'formData', bodyType: 'json',
      }), new OpenApiRequest({ query: { SiteId: destination.siteId, ... query } }), new RuntimeOptions({
        autoretry: false, readTimeout: destination.timeoutMs, connectTimeout: destination.timeoutMs,
      }))
      if (response.statusCode !== 200 || ! response.body || typeof response.body !== 'object')
        throw new Error('Invalid ESA response')
      return response.body as Record<string, unknown>
    }
    catch {
      throw new ApiError(502, 'ESA 缓存刷新请求失败')
    }
  }
  async function submit(base: string, key: string) {
    const body = await call('PurgeCaches', { Type: 'file', Content: JSON.stringify({ Files: [retirement_url(base, key)] }) })
    if (typeof body.TaskId !== 'string' || ! /^[\w-]{1,128}$/.test(body.TaskId))
      throw new ApiError(502, 'ESA 未返回有效刷新任务')
    return body.TaskId
  }
  async function status(base: string, key: string, task: string) {
    const url = retirement_url(base, key)
    // Exact Content filtering keeps history small; pagination still matters
    // after lost acknowledgements and manual retries of the same object.
    for (let page = 1; page <= 20; page ++) {
      const body = await call('DescribePurgeTasks', { Type: 'file', Content: url, PageNumber: String(page), PageSize: '50' })
      if (! Array.isArray(body.Tasks) || ! Number.isSafeInteger(body.TotalCount) || Number(body.TotalCount) < 0)
        throw new ApiError(502, 'ESA 刷新任务响应无效')
      const found = body.Tasks.find((item: Record<string, unknown>) => item.TaskId === task && item.Content === url && item.Type === 'file')
      if (found) {
        if (found.Status === 'Complete' || found.Status === 'Refreshing' || found.Status === 'Failed')
          return found.Status as 'Complete' | 'Refreshing' | 'Failed'
        throw new ApiError(502, 'ESA 刷新任务状态无效')
      }
      if (page * 50 >= Number(body.TotalCount))
        return 'Missing'
    }
    return 'Missing'
  }
  return { submit, status }
}
