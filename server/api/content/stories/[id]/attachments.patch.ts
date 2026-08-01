import { require_admin_user } from '@server/services/auth-guards.service'
import { rename_attachment } from '@server/services/content.service'
import { ok } from '@server/types/response'
import { schema } from '@shared/validate'

export default defineEventHandler(async (event) => {
  await require_admin_user(event)

  const { id } = schema.content_story_id.parse(event.context.params)
  const payload = schema.content_attachment_rename.parse(await readBody(event))
  const static_root = useRuntimeConfig(event).static_root

  const attachment = await rename_attachment(id, payload.old_file_name, payload.file_name, static_root)
  return ok(attachment, '附件已重命名')
})
