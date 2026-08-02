import {
  create_story,
  delete_attachment,
  delete_story,
  get_story,
  list_stories,
  rename_attachment,
  update_story,
  upload_attachment,
} from '@server/services/content.service'
import { admin_procedure, public_procedure, router } from '@server/trpc/init'
import { api_schema } from '@server/trpc/schemas'

export const content_router = router({
  listStories: public_procedure.query(() => list_stories()),

  getStory: public_procedure
    .input(api_schema.content.get_story)
    .query(({ input }) => get_story(input.id)),

  createStory: admin_procedure
    .input(api_schema.content.create_story)
    .mutation(async ({ ctx, input }) => ({
      id: await create_story(ctx.auth_user.id, input.markdown),
    })),

  updateStory: admin_procedure
    .input(api_schema.content.update_story)
    .mutation(async ({ ctx, input }) => {
      await update_story(
        input.id,
        input.markdown,
        input.delete_files,
        input.base_updated_at,
        useRuntimeConfig(ctx.event).static_root,
      )
    }),

  deleteStory: admin_procedure
    .input(api_schema.content.delete_story)
    .mutation(({ ctx, input }) => delete_story(input.id, useRuntimeConfig(ctx.event).static_root)),

  uploadAttachment: admin_procedure
    .input(api_schema.content.upload_attachment)
    .mutation(async ({ ctx, input }) => {
      const { id } = api_schema.content.get_story.parse({ id: input.get('story_id') })
      return upload_attachment(id, input, () => {
        const config = useRuntimeConfig(ctx.event)
        return {
          max_size_mb: config.public.max_content_attachment_size_mb as number,
          static_root: config.static_root,
        }
      })
    }),

  renameAttachment: admin_procedure
    .input(api_schema.content.rename_attachment)
    .mutation(({ ctx, input }) => rename_attachment(
      input.id,
      input.old_file_name,
      input.file_name,
      useRuntimeConfig(ctx.event).static_root,
    )),

  deleteAttachment: admin_procedure
    .input(api_schema.content.delete_attachment)
    .mutation(({ ctx, input }) => delete_attachment(
      input.id,
      input.file_name,
      input.markdown,
      input.base_updated_at,
      useRuntimeConfig(ctx.event).static_root,
    )),
})
