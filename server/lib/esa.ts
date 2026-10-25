import type { aliyun_esa_config_schema } from '@config/schema'
import type { z } from 'zod'
import type { EsaReadGrant } from './esa-access'
import { createHash, randomUUID } from 'node:crypto'
import { runtime_config } from '@config/loader'
import { ApiError } from '@server/errors/ApiError'
import { content_disposition } from '@server/lib/content-disposition'
import { content_signature_metadata } from '../../config/esa/content-auth.mjs'
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
    // Bind response metadata into Type A's signed rand field. Never let unsigned
    // query parameters change filenames or poison the shared object cache.
    const access = grant ? encode_esa_read_grant(grant) : undefined
    const rand = access || header ? content_signature_metadata(header, access) : randomUUID().replaceAll('-', '')
    const uid = access ? '1' : '0'
    const timestamp = Math.floor(Date.now() / 1000) - Math.max(0, destination.urlTtlSeconds - expires_in)
    const hash = createHash('md5').update([url.pathname, timestamp, rand, uid, destination.authKey].join('-')).digest('hex')
    url.searchParams.set('auth_key', `${timestamp}-${rand}-${uid}-${hash}`)
    if (header)
      url.searchParams.set('response-content-disposition', header)
    if (access)
      url.searchParams.set('access', access)
    return url.href
  }
  return { signed_read_url }
}
