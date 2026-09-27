import { require_auth_user } from '@server/services/auth-guards.service'
import { get_bilibili_video_cards } from '@server/services/bilibili.service'
import {
  confirm_attachment_upload,
  create_abridged_attachment,
  create_folder,
  create_story,
  decrypt_attachments,
  delete_attachment,
  delete_folder,
  delete_orphan_attachment,
  delete_story,
  encrypt_attachments,
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
import { permission_procedure, public_procedure, router } from '@server/trpc/init'
import { api_schema } from '@server/trpc/schemas'
import { has_permission } from '@shared/permissions'
import * as z from 'zod'

const content_admin_procedure = permission_procedure('content_manage', 'full')

export const content_router = router({
  listStories: public_procedure.query(() => list_stories()),

  getStory: public_procedure
    .input(api_schema.content.get_story)
    .query(async ({ ctx, input }) => {
      let viewer = null
      try {
        viewer = await require_auth_user(ctx.event)
      }
      catch {
        viewer = null
      }
      return input.base_updated_at === undefined
        ? get_story(input.id, undefined, viewer)
        : get_story(input.id, input.base_updated_at, viewer)
    }),

  listOrphanAttachments: content_admin_procedure.query(() => list_orphan_attachments()),

  createStory: content_admin_procedure
    .input(api_schema.content.create_story)
    .mutation(async ({ ctx, input }) => ({
      id: await create_story(ctx.auth_user.id, input.markdown, input.claim_files, has_permission(ctx.auth_user, 'content_private', 'read')),
    })),

  updateStory: content_admin_procedure
    .input(api_schema.content.update_story)
    .mutation(async ({ ctx, input }) => {
      await update_story(
        input.id,
        input.markdown,
        input.delete_files,
        input.base_revision,
        has_permission(ctx.auth_user, 'content_private', 'read'),
      )
    }),

  deleteStory: content_admin_procedure
    .input(api_schema.content.delete_story)
    .mutation(({ input }) => delete_story(input.id)),

  uploadAttachment: content_admin_procedure
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

  signAttachmentUpload: content_admin_procedure
    .input(api_schema.content.sign_attachment_upload)
    .mutation(({ input }) => sign_attachment_upload(input)),

  confirmAttachmentUpload: content_admin_procedure
    .input(api_schema.content.confirm_attachment_upload)
    .mutation(async ({ ctx, input }) => {
      const config = useRuntimeConfig(ctx.event)
      return confirm_attachment_upload(input.story_id, input.key, input.file_name, config.public.max_content_attachment_size_mb as number)
    }),

  renameAttachment: content_admin_procedure
    .input(api_schema.content.rename_attachment)
    .mutation(({ input }) => rename_attachment(
      input.id || null,
      input.old_file_name,
      input.file_name,
    )),

  replaceAttachment: content_admin_procedure
    .input(api_schema.content.replace_attachment)
    .mutation(async ({ ctx, input }) => {
      const raw_id = z.coerce.number().int().min(0).parse(input.get('story_id'))
      const old_file_name = z.string().min(1).max(120).parse(input.get('old_file_name'))
      const mode = z.enum(['keep-name', 'new-name']).parse(input.get('mode'))
      return replace_attachment(raw_id || null, old_file_name, input, mode, () => {
        const config = useRuntimeConfig(ctx.event)
        return {
          max_size_mb: config.public.max_content_attachment_size_mb as number,
        }
      })
    }),

  deleteAttachment: content_admin_procedure
    .input(api_schema.content.delete_attachment)
    .mutation(({ ctx, input }) => delete_attachment(
      input.id,
      input.file_name,
      input.markdown,
      input.base_revision,
      has_permission(ctx.auth_user, 'content_private', 'read'),
    )),

  deleteOrphanAttachment: content_admin_procedure
    .input(api_schema.content.delete_orphan_attachment)
    .mutation(({ input }) => delete_orphan_attachment(input.file_name)),

  moveAttachment: content_admin_procedure
    .input(api_schema.content.move_attachment)
    .mutation(({ input }) => move_attachment(
      input.id || null,
      input.file_name,
      input.target_folder,
    )),

  moveAttachments: content_admin_procedure
    .input(api_schema.content.move_attachments)
    .mutation(({ input }) => move_attachments(
      input.id || null,
      input.moves,
    )),

  encryptAttachments: content_admin_procedure
    .input(api_schema.content.encrypt_attachments)
    .mutation(({ input }) => encrypt_attachments(input.id || null, input.file_names)),

  decryptAttachments: content_admin_procedure
    .input(api_schema.content.decrypt_attachments)
    .mutation(({ input }) => decrypt_attachments(input.id || null, input.file_names)),

  createAbridgedAttachment: content_admin_procedure
    .input(api_schema.content.create_abridged_attachment)
    .mutation(async ({ ctx, input }) => {
      const raw_id = z.coerce.number().int().min(0).parse(input.get('story_id'))
      const source_file_name = z.string().min(1).max(255).parse(input.get('source_file_name'))
      return create_abridged_attachment(raw_id || null, source_file_name, input, () => {
        const config = useRuntimeConfig(ctx.event)
        return {
          max_size_mb: config.public.max_content_attachment_size_mb as number,
        }
      })
    }),

  createFolder: content_admin_procedure
    .input(api_schema.content.create_folder)
    .mutation(({ input }) => create_folder(input.id || null, input.folder)),

  deleteFolder: content_admin_procedure
    .input(api_schema.content.delete_folder)
    .mutation(({ input }) => delete_folder(input.id || null, input.folder)),

  moveFolder: content_admin_procedure
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
