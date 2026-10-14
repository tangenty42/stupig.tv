// Read-only by default. --apply converts saved Markdown under per-story locks.
import { db } from '@server/lib/db'
import { get_mqtt_client } from '@server/lib/mqtt'
import { migrate_content_references } from '@server/services/content/reference-migration.service'
import { settings } from '@shared/settings'

const arguments_ = process.argv.slice(2).filter(argument => argument !== '--')
if (arguments_.some(argument => argument !== '--apply'))
  throw new Error('仅支持 --apply；默认 dry-run')

let wrote_stories = false
try {
  const apply = arguments_.includes('--apply')
  const reports = await migrate_content_references(apply, (item) => {
    wrote_stories ||= item.applied
    console.log(JSON.stringify(item))
  })
  console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', stories: reports.length, changed: reports.filter(item => item.changed).length }))
}
finally {
  if (wrote_stories) {
    const client = get_mqtt_client()
    if (client) {
      // Let queued refreshes reach the broker before the maintenance process exits.
      await new Promise<void>((resolve) => {
        let timer: ReturnType<typeof setTimeout>
        function finish() {
          clearTimeout(timer)
          client!.removeListener('connect', connected)
          resolve()
        }
        function connected() {
          client!.end(false, {}, finish)
        }
        timer = setTimeout(() => {
          console.warn('刷新通知未能在期限内完成；客户端需在重连后重新获取档案')
          client.end(true, {}, finish)
        }, settings.app.client.sync.connectTimeoutMs)
        if (client.connected)
          connected()
        else
          client.once('connect', connected)
      })
    }
  }
  await db.end()
}
