import type { Pool, RowDataPacket } from 'mysql2/promise'
import { create_audit_catalog } from '@server/services/storage-audit/repository'

export type Protection = 'reference' | 'workflow' | 'retired' | 'registered_upload' | 'static_namespace' | 'none' | 'unverified'
export function inventory_execute(connection: Pick<Pool, 'execute'>): Pick<Pool, 'execute'> {
  const execute: Pool['execute'] = ((sql: unknown, ... parameters: unknown[]) => {
    if (typeof sql !== 'string' || ! /^SELECT\b/i.test(sql.trimStart()) || /\b(?:FOR\s+UPDATE|INTO\s+OUTFILE|INTO\s+DUMPFILE)\b/i.test(sql))
      throw new Error('inventory_write_rejected')
    return Reflect.apply(connection.execute, connection, [sql, ... parameters])
  }) as Pool['execute']
  return { execute }
}
/** SELECT-only catalog; key-level protection deliberately retains every historical version of a protected key. */
export function create_inventory_catalog(connection: Pick<Pool, 'execute'>, destination: { bucket: string, endpoint: string }) {
  const catalog = create_audit_catalog(connection, destination, [])
  const cache = new Map<string, Protection>()
  return async (key: string, upload_id?: string): Promise<Protection> => {
    if (upload_id) {
      const [rows] = await connection.execute<RowDataPacket[]>('SELECT id FROM content_transfer_attempts WHERE target_key=? AND upload_id=? LIMIT 1', [key, upload_id])
      if (rows.length)
        return 'registered_upload'
    }
    if (cache.has(key))
      return cache.get(key)!
    let result: Protection
    if (key.startsWith('imgs/')) {
      result = 'static_namespace'
    }
    else if (await catalog.reference(key)) {
      result = 'reference'
    }
    else {
      const ownership = await catalog.ownership(key)
      result = ownership === 'tracked' ? 'workflow' : ownership === 'retired' ? 'retired' : 'none'
    }
    cache.set(key, result)
    if (cache.size > 128)
      cache.delete(cache.keys().next().value!)
    return result
  }
}
