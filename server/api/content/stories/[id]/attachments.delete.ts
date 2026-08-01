import { unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { ApiError } from '@server/errors/ApiError'
import { require_admin_user } from '@server/services/auth-guards.service'
import { update_story } from '@server/services/content.service'
import { ok } from '@server/types/response'
import { schema } from '@shared/validate'

export default defineEventHandler(async (event) => {
  await require_admin_user(event)

  const { id } = schema.content_story_id.parse(event.context.params)
  const payload = schema.content_attachment_delete.parse(await readBody(event))
  const deleted_files = await update_story(id, payload.markdown, [payload.file_name])
  if (! deleted_files.includes(payload.file_name)) {
    throw new ApiError(404, '附件不存在或已被删除')
  }

  const static_root = useRuntimeConfig(event).static_root
  await unlink(join(static_root, 'content', String(id), payload.file_name)).catch(() => {})

  return ok(null, '附件已删除')
})
