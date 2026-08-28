import { get_bilibili_video_cards } from '@server/services/bilibili.service'
import {
  create_story,
  delete_attachment,
  delete_orphan_attachment,
  delete_story,
  get_story,
  list_orphan_attachments,
  list_stories,
  rename_attachment,
  replace_attachment,
  update_story,
  upload_attachment,
} from '@server/services/content.service'
import { admin_procedure, public_procedure, router } from '@server/trpc/init'
import { api_schema } from '@server/trpc/schemas'
import * as z from 'zod'

export const content_router = router({
  listStories: public_procedure.query(() => list_stories()),

  getStory: public_procedure
    .input(api_schema.content.get_story)
    .query(({ input }) => input.base_updated_at === undefined
      ? get_story(input.id)
      : get_story(input.id, input.base_updated_at)),

  listOrphanAttachments: admin_procedure.query(() => list_orphan_attachments()),

  createStory: admin_procedure
    .input(api_schema.content.create_story)
    .mutation(async ({ ctx, input }) => ({
      id: await create_story(ctx.auth_user.id, input.markdown, input.claim_files, useRuntimeConfig(ctx.event).static_root),
    })),

  updateStory: admin_procedure
    .input(api_schema.content.update_story)
    .mutation(async ({ ctx, input }) => {
      await update_story(
        input.id,
        input.markdown,
        input.delete_files,
        input.base_revision,
        useRuntimeConfig(ctx.event).static_root,
      )
    }),

  deleteStory: admin_procedure
    .input(api_schema.content.delete_story)
    .mutation(({ ctx, input }) => delete_story(input.id, useRuntimeConfig(ctx.event).static_root)),

  uploadAttachment: admin_procedure
    .input(api_schema.content.upload_attachment)
    .mutation(async ({ ctx, input }) => {
      const raw_id = z.coerce.number().int().min(0).parse(input.get('story_id'))
      return upload_attachment(raw_id || null, input, () => {
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

  replaceAttachment: admin_procedure
    .input(api_schema.content.replace_attachment)
    .mutation(async ({ ctx, input }) => {
      const raw_id = z.coerce.number().int().min(1).parse(input.get('story_id'))
      const old_file_name = z.string().min(1).max(120).parse(input.get('old_file_name'))
      const mode = z.enum(['keep-name', 'new-name']).parse(input.get('mode'))
      return replace_attachment(raw_id, old_file_name, input, mode, () => {
        const config = useRuntimeConfig(ctx.event)
        return {
          max_size_mb: config.public.max_content_attachment_size_mb as number,
          static_root: config.static_root,
        }
      })
    }),

  deleteAttachment: admin_procedure
    .input(api_schema.content.delete_attachment)
    .mutation(({ ctx, input }) => delete_attachment(
      input.id,
      input.file_name,
      input.markdown,
      input.base_revision,
      useRuntimeConfig(ctx.event).static_root,
    )),

  deleteOrphanAttachment: admin_procedure
    .input(api_schema.content.delete_orphan_attachment)
    .mutation(({ ctx, input }) => delete_orphan_attachment(
      input.file_name,
      useRuntimeConfig(ctx.event).static_root,
    )),

  getBilibiliVideoCards: public_procedure
    .input(api_schema.content.get_bilibili_video_cards)
    .query(({ input }) => get_bilibili_video_cards(input.hrefs)),
})
