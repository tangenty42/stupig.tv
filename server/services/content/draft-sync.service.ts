import type { AuthUser } from '@server/types/auth'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { runtime_config } from '@config/loader'
import { db } from '@server/lib/db'
import { settings } from '@shared/settings'
import { require_draft_actor } from './draft-auth.service'

const lifetime_seconds = settings.app.content.draft.notificationCredentialSeconds
const sign = (value: string) => createHmac('sha256', runtime_config().app.auth.jwt.secret).update(`draft-mqtt:v1:${value}`).digest('hex')

export async function draft_sync_credentials(actor: AuthUser) {
  const connection = await db.getConnection()
  try {
    await connection.beginTransaction()
    await require_draft_actor(connection, actor)
    const expires_at = Math.floor(Date.now() / 1000) + lifetime_seconds
    const payload = Buffer.from(JSON.stringify({ id: actor.id, session_id: actor.session_id, token_generation_id: actor.token_generation_id, expires_at })).toString('base64url')
    await connection.commit()
    return { username: 'draft-v1', password: `${payload}.${sign(payload)}`, expires_at }
  }
  catch (error) {
    await connection.rollback()
    throw error
  }
  finally { connection.release() }
}

/** Called by the broker's authenticated listener, never returns body or lease credentials. */
export async function authenticate_draft_sync(input: { username?: string, password?: string }) {
  try {
    if (input.username !== 'draft-v1' || ! input.password || input.password.length > 1024)
      return { result: 'deny' as const }
    const [payload, signature, extra] = input.password.split('.')
    if (! payload || ! signature || extra || ! /^[a-f0-9]{64}$/.test(signature) || ! timingSafeEqual(Buffer.from(signature), Buffer.from(sign(payload))))
      return { result: 'deny' as const }
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString()) as AuthUser & { expires_at: number }
    if (! Number.isSafeInteger(parsed.expires_at) || parsed.expires_at <= Date.now() / 1000 || parsed.expires_at > Date.now() / 1000 + lifetime_seconds)
      return { result: 'deny' as const }
    const connection = await db.getConnection()
    try {
      await connection.beginTransaction()
      await require_draft_actor(connection, parsed)
      await connection.commit()
    }
    catch (error) {
      await connection.rollback()
      throw error
    }
    finally { connection.release() }
    return {
      result: 'allow' as const, is_superuser: false, expire_at: parsed.expires_at,
      acl: [{ permission: 'allow', action: 'subscribe', topic: `${settings.integrations.mqtt.privateTopicPrefix}/#` }, { permission: 'deny', action: 'all', topic: '#' }],
    }
  }
  catch { return { result: 'deny' as const } }
}
