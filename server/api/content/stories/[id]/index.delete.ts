import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { require_admin_user } from '@server/services/auth-guards.service'
import { delete_story } from '@server/services/content.service'
import { ok } from '@server/types/response'
import { schema } from '@shared/validate'

export default defineEventHandler(async (event) => {
  await require_admin_user(event)

  const { id } = schema.content_story_id.parse(event.context.params)

  await delete_story(id)

  const static_root = useRuntimeConfig(event).static_root
  try {
    await rm(join(static_root, 'content', String(id)), { recursive: true, force: true })
  }
  catch {
  }

  return ok(null, '档案已删除')
})
