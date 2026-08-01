import { unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { require_admin_user } from '@server/services/auth-guards.service'
import { update_story } from '@server/services/content.service'
import { ok } from '@server/types/response'
import { schema } from '@shared/validate'

export default defineEventHandler(async (event) => {
  await require_admin_user(event)

  const { id } = schema.content_story_id.parse(event.context.params)
  const body = await readBody(event)
  const payload = schema.content_story_update.parse(body)

  const deleted_files = await update_story(id, payload.markdown, payload.delete_files)

  const static_root = useRuntimeConfig(event).static_root
  for (const file_name of deleted_files) {
    try {
      await unlink(join(static_root, 'content', String(id), file_name))
    }
    catch {
    }
  }

  return ok(null, '档案已保存')
})
