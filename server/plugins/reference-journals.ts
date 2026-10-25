import { log_error } from '@server/lib/log'
import { prune_reference_journals } from '@server/services/content/reference-history.service'
import { settings } from '@shared/settings'

export default defineNitroPlugin((app) => {
  let running = false
  const timer = setInterval(async () => {
    if (running)
      return
    running = true
    try {
      await prune_reference_journals()
    }
    catch (error) {
      log_error('content reference journal cleanup failed', { error: String(error) })
    }
    finally {
      running = false
    }
  }, settings.app.content.reference.sweepIntervalSeconds * 1000)
  timer.unref()
  app.hooks.hook('close', () => {
    clearInterval(timer)
  })
})
