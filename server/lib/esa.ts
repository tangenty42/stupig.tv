import type { aliyun_esa_config_schema } from '@config/schema'
import type { z } from 'zod'
import type { EsaReadGrant } from './esa-access'
import { randomUUID } from 'node:crypto'
import { runtime_config } from '@config/loader'
import { ApiError } from '@server/errors/ApiError'
import { content_disposition } from '@server/lib/content-disposition'
import { content_url_signature } from '../../config/esa/content-auth.mjs'
import { encode_esa_read_grant } from './esa-access'

/** Browser reads only. Uploads and server-side processing keep the OSS SDK. */
export function create_esa(config: z.infer<typeof aliyun_esa_config_schema> | null = runtime_config().aliyun.esa) {
  if (! config?.authKey)
    throw new ApiError(503, 'ESA 读取鉴权尚未配置')
  const destination = config
  function signed_read_url(key: string, expires_in: number, method: 'GET' | 'HEAD' = 'GET', download_name?: string, disposition: 'attachment' | 'inline' = 'attachment', grant?: EsaReadGrant) {
    if (! key.startsWith('content/att/') || /[\\?\0\r\n]/.test(key) || key.split('/').some(part => ! part || part === '.' || part === '..'))
      throw new ApiError(400, '附件对象标识无效')
    if (! Number.isSafeInteger(expires_in) || expires_in < 1 || ! ['GET', 'HEAD'].includes(method) || ! ['inline', 'attachment'].includes(disposition))
      throw new ApiError(400, '读取签名参数无效')
    const url = new URL(`/${key.split('/').map(encodeURIComponent).join('/')}`, destination.baseUrl)
    const header = download_name ? content_disposition(download_name, disposition) : ''
    const access = grant ? encode_esa_read_grant(grant) : undefined
    if (header)
      url.searchParams.set('response-content-disposition', header)
    if (access)
      url.searchParams.set('access', access)
    const issued_at = String(Math.floor(Date.now() / 1000))
    const expires_at = String(Number(issued_at) + Math.min(expires_in, destination.urlTtlSeconds))
    const nonce = randomUUID().replaceAll('-', '')
    const signature = content_url_signature(destination.authKey, url, issued_at, expires_at, nonce)
    const query = new URLSearchParams({ auth_key: `v2-${issued_at}-${expires_at}-${nonce}-${signature}` })
    for (const [name, value] of url.searchParams)
      query.set(name, value)
    url.search = query.toString()
    return url.href
  }
  return { signed_read_url }
}
