import type { AuthUser } from '@server/types/auth'
import type { RowDataPacket } from 'mysql2/promise'
import type { ImageAccessRow } from './attachment-access.service'
import { runtime_config } from '@config/loader'
import { ApiError } from '@server/errors/ApiError'
import { db } from '@server/lib/db'
import { decode_esa_read_grant } from '@server/lib/esa-access'
import { normalize_permission_grants } from '@shared/permissions'
import { z } from 'zod'
import { authorize_content_request, content_authorization_proof } from '../../../config/esa/content-auth.mjs'
import { resolve_attachment_delivery } from './attachment-access.service'

export const edge_read_request = z.strictObject({
  url: z.string().url().max(4096),
  method: z.enum(['GET', 'HEAD']),
  nonce: z.string().uuid(),
})

/** Fresh primary-DB snapshot on every request; never cache an allow decision. */
export async function authorize_edge_read(input: z.infer<typeof edge_read_request>) {
  const config = runtime_config().aliyun.esa
  if (! config?.authKey)
    throw new ApiError(503, '读取鉴权尚未配置')
  let grant
  let key
  try {
    const request = new Request(input.url, { method: input.method })
    const verified = authorize_content_request(config.authKey, config.urlTtlSeconds, request)
    const url = verified.url
    if (! url || url.origin !== new URL(config.baseUrl).origin || url.hash || url.username || url.password
      || url.search.slice(1) !== url.searchParams.toString() || ! url.pathname.startsWith('/content/att/')) {
      return null
    }
    grant = decode_esa_read_grant(url.searchParams.get('access') ?? '')
    key = decodeURIComponent(url.pathname.slice(1))
    if (`/${key.split('/').map(encodeURIComponent).join('/')}` !== url.pathname)
      return null
  }
  catch { return null }
  const connection = await db.getConnection()
  try {
    await connection.beginTransaction()
    let viewer: AuthUser | null = null
    if (grant.session) {
      const [users] = await connection.execute<RowDataPacket[]>(`SELECT u.id, u.username, u.phone, u.avatar_file, u.is_verified, u.is_admin, u.permissions
        FROM user_login_session_tokens t INNER JOIN user_login_sessions s ON s.id = t.session_id INNER JOIN users u ON u.id = s.user_id
        WHERE s.id = ? AND t.id = ? AND t.expires_at > CURRENT_TIMESTAMP
        AND s.is_logged_out = 0 AND s.expires_at > CURRENT_TIMESTAMP AND u.is_banned = 0`, [grant.session, grant.generation])
      const user = users[0]
      if (! user) {
        await connection.rollback()
        return null
      }
      viewer = { id: Number(user.id), session_id: grant.session, token_generation_id: grant.generation, username: user.username, phone: user.phone, avatar_file: user.avatar_file,
        is_verified: Boolean(user.is_verified), is_admin: Boolean(user.is_admin), permissions: normalize_permission_grants(user.permissions) }
    }
    const [rows] = await connection.execute<(RowDataPacket & ImageAccessRow)[]>(`SELECT a.* FROM content_story_attachments a
      INNER JOIN content_stories s ON s.id = a.story_id WHERE a.id = ? AND a.is_folder = 0`, [grant.id])
    if (! rows[0]) {
      await connection.rollback()
      return null
    }
    const current = await resolve_attachment_delivery(rows[0], grant.role, viewer, connection)
    const allowed = current.key === key && current.grant.revision === grant.revision
    await connection.commit()
    return allowed ? content_authorization_proof(config.authKey, input.nonce, input.url, input.method) : null
  }
  catch (error) {
    await connection.rollback()
    if (error instanceof ApiError && [403, 404, 409].includes(error.statusCode))
      return null
    throw error
  }
  finally { connection.release() }
}
