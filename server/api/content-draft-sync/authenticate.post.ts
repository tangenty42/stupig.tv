import { authenticate_draft_sync } from '@server/services/content/draft-sync.service'

export default defineEventHandler(async (event) => {
  setResponseHeader(event, 'Cache-Control', 'no-store')
  const input = await readBody<{ username?: string, password?: string }>(event)
  return authenticate_draft_sync({ username: typeof input?.username === 'string' ? input.username : '', password: typeof input?.password === 'string' ? input.password : '' })
})
