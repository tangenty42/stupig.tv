import type { Connection } from 'mysql2/promise'
import { createHash } from 'node:crypto'
import { runtime_config } from '@config/loader'
import { retirement_url } from '@server/lib/esa-purge'

export function preload_destination(site: string, base: string) {
  return createHash('sha256').update(JSON.stringify([site, base])).digest('hex')
}

/** Called inside publication, only for committed display representations. No network I/O. */
export async function enqueue_preload(connection: Connection, scope: number, attachment: number, objects: { key: string, size: number }[]) {
  const { app, aliyun } = runtime_config()
  if (! app?.contentPreload?.enabled || ! aliyun.esa || ! aliyun.esaPurge?.siteId)
    return
  const site = aliyun.esaPurge.siteId
  const base = aliyun.esa.baseUrl
  const destination = preload_destination(site, base)
  const selected = objects.filter(object => Number.isSafeInteger(object.size) && object.size > 0 && object.size <= app.contentPreload.maxObjectBytes)
  if (! selected.length)
    return
  await connection.execute('INSERT IGNORE INTO content_preload_sites (destination_id, site_id, base_url) VALUES (?, ?, ?)', [destination, site, base])
  for (const object of selected) {
    retirement_url(base, object.key)
    await connection.execute(`INSERT IGNORE INTO content_preload_jobs (destination_id, scope_id, attachment_id, object_key) VALUES (?, ?, ?, ?)`,
      [destination, scope, attachment, object.key])
  }
}
