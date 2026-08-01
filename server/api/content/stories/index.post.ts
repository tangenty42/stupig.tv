import { require_admin_user } from '@server/services/auth-guards.service'
import { create_story } from '@server/services/content.service'
import { ok } from '@server/types/response'
import { schema } from '@shared/validate'

export default defineEventHandler(async (event) => {
  const user = await require_admin_user(event)

  const body = await readBody(event)
  const payload = schema.content_story_create.parse(body)

  const id = await create_story(user.id, payload.markdown)
  return ok({ id }, '档案已创建')
})
