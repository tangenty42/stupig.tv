import { get_story } from '@server/services/content.service'
import { ok } from '@server/types/response'
import { schema } from '@shared/validate'

export default defineEventHandler(async (event) => {
  const { id } = schema.content_story_id.parse(event.context.params)

  const story = await get_story(id)
  return ok(story)
})
