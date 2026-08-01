import { list_stories } from '@server/services/content.service'
import { ok } from '@server/types/response'

export default defineEventHandler(async () => {
  const stories = await list_stories()
  return ok(stories)
})
