import { require_auth_user } from '@server/services/auth-guards.service'
import { draft_sync_credentials } from '@server/services/content/draft-sync.service'

export default defineEventHandler(async (event) => {
  setResponseHeader(event, 'Cache-Control', 'no-store')
  return draft_sync_credentials(await require_auth_user(event))
})
