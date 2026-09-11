import { get_bilibili_video_cards } from '@server/services/bilibili.service'
import {
  confirm_attachment_upload,
  create_folder,
  create_story,
  delete_attachment,
  delete_folder,
  delete_orphan_attachment,
  delete_story,
  get_story,
  list_orphan_attachments,
  list_stories,
  move_attachment,
  move_attachments,
  move_folder,
  rename_attachment,
  replace_attachment,
  sign_attachment_upload,
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
      id: await create_story(ctx.auth_user.id, input.markdown, input.claim_files),
    })),

  updateStory: admin_procedure
    .input(api_schema.content.update_story)
    .mutation(async ({ input }) => {
      await update_story(
        input.id,
        input.markdown,
        input.delete_files,
        input.base_revision,
      )
    }),

  deleteStory: admin_procedure
    .input(api_schema.content.delete_story)
    .mutation(({ input }) => delete_story(input.id)),

  uploadAttachment: admin_procedure
    .input(api_schema.content.upload_attachment)
    .mutation(async ({ ctx, input }) => {
      const raw_id = z.coerce.number().int().min(0).parse(input.get('story_id'))
      return upload_attachment(raw_id || null, input, () => {
        const config = useRuntimeConfig(ctx.event)
        return {
          max_size_mb: config.public.max_content_attachment_size_mb as number,
        }
      })
    }),

  signAttachmentUpload: admin_procedure
    .input(api_schema.content.sign_attachment_upload)
    .mutation(({ input }) => sign_attachment_upload(input)),

  confirmAttachmentUpload: admin_procedure
    .input(api_schema.content.confirm_attachment_upload)
    .mutation(async ({ ctx, input }) => {
      const config = useRuntimeConfig(ctx.event)
      return confirm_attachment_upload(input.story_id, input.key, input.file_name, config.public.max_content_attachment_size_mb as number)
    }),

  renameAttachment: admin_procedure
    .input(api_schema.content.rename_attachment)
    .mutation(({ input }) => rename_attachment(
      input.id,
      input.old_file_name,
      input.file_name,
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
        }
      })
    }),

  deleteAttachment: admin_procedure
    .input(api_schema.content.delete_attachment)
    .mutation(({ input }) => delete_attachment(
      input.id,
      input.file_name,
      input.markdown,
      input.base_revision,
    )),

  deleteOrphanAttachment: admin_procedure
    .input(api_schema.content.delete_orphan_attachment)
    .mutation(({ input }) => delete_orphan_attachment(input.file_name)),

  moveAttachment: admin_procedure
    .input(api_schema.content.move_attachment)
    .mutation(({ input }) => move_attachment(
      input.id || null,
      input.file_name,
      input.target_folder,
    )),

  moveAttachments: admin_procedure
    .input(api_schema.content.move_attachments)
    .mutation(({ input }) => move_attachments(
      input.id || null,
      input.moves,
    )),

  createFolder: admin_procedure
    .input(api_schema.content.create_folder)
    .mutation(({ input }) => create_folder(input.id || null, input.folder)),

  deleteFolder: admin_procedure
    .input(api_schema.content.delete_folder)
    .mutation(({ input }) => delete_folder(input.id || null, input.folder)),

  moveFolder: admin_procedure
    .input(api_schema.content.move_folder)
    .mutation(({ input }) => move_folder(
      input.id || null,
      input.source_folder,
      input.new_folder,
    )),

  getBilibiliVideoCards: public_procedure
    .input(api_schema.content.get_bilibili_video_cards)
    .query(({ input }) => get_bilibili_video_cards(input.hrefs)),
})
