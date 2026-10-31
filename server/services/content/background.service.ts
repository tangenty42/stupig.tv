import type { BackgroundAdapter } from '@server/services/background/runner'
import { runtime_config } from '@config/loader'
import { db } from '@server/lib/db'
import { log_error } from '@server/lib/log'
import { publish_sync_confirmed } from '@server/lib/mqtt'
import { create_background_runner } from '@server/services/background/runner'
import { sweep_storage_audit } from '@server/services/storage-audit/service'
import { create_content_receipt_compactor } from './command-receipts.service'
import { sweep_object_retirements } from './object-retirement.service'
import { sweep_preloads } from './preload.service'
import { create_content_sync_dispatcher } from './sync-outbox.service'
import { sweep_content_images, sweep_content_uploads } from './upload-api.service'

export function content_background_adapters(): BackgroundAdapter[] {
  const { app } = runtime_config()
  return [
    { id: 'images', intervalSeconds: app.contentImages.sweepIntervalSeconds, resources: { image: 1, oss: 1 }, sweep: sweep_content_images },
    { id: 'uploads', intervalSeconds: app.contentUploads.sweepIntervalSeconds, resources: { oss: 1 }, sweep: sweep_content_uploads },
    { id: 'retirement', intervalSeconds: app.contentRetirement.sweepIntervalSeconds, resources: { oss: 1, esa: 1 }, sweep: signal => sweep_object_retirements(undefined, signal) },
    { id: 'preload', intervalSeconds: app.contentPreload.sweepIntervalSeconds, resources: { esa: 1 }, sweep: sweep_preloads },
    { id: 'sync', intervalSeconds: app.contentSync.sweepIntervalSeconds, resources: { notification: 1 }, sweep: create_content_sync_dispatcher(db, publish_sync_confirmed, app.contentSync) },
    { id: 'receipts', intervalSeconds: app.contentReceipts.sweepIntervalSeconds, resources: {}, sweep: create_content_receipt_compactor(db, app.contentReceipts) },
    { id: 'storage_audit', intervalSeconds: app.storageAudit.sweepIntervalSeconds, resources: { oss: 1 }, sweep: sweep_storage_audit },
  ]
}

export function create_content_background_runner() {
  return create_background_runner(runtime_config().app.backgroundRunner, (adapter, code) => {
    log_error('background execution failed', { adapter, code })
  })
}

type Runner = ReturnType<typeof create_content_background_runner>
interface Host { hooks: { hook: (name: 'close', callback: () => Promise<void>) => unknown } }
const hosts = new WeakMap<Host, { runner: Runner, adapters: BackgroundAdapter[] }>()
let local: Runner | null = null

/** Domain plugins register with one app-scoped runner and close hook. */
export function register_content_background(host: Host, id: string) {
  if (runtime_config().app.backgroundRunner.mode !== 'app')
    return
  let state = hosts.get(host)
  if (! state) {
    state = { runner: create_content_background_runner(), adapters: content_background_adapters() }
    hosts.set(host, state)
    local = state.runner
    const runner = state.runner
    host.hooks.hook('close', async () => {
      await runner.close()
      if (local === runner)
        local = null
    })
  }
  const adapter = state.adapters.find(adapter => adapter.id === id)
  if (! adapter)
    throw new Error('Unknown background adapter')
  state.runner.register(adapter)
}

export function local_background_status() {
  return local?.snapshot() ?? null
}
