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
  delete_story,
  encrypt_attachments,
  get_story,
  list_stories,
  move_attachment,
  move_attachments,
  move_folder,
  rename_attachment,
  replace_attachment,
  sign_attachment_download,
  sign_attachment_upload,
  update_story,
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
      return input.base_updated_at === undefined || input.base_viewer_key === undefined
        ? get_story(input.id, undefined, viewer)
        : get_story(input.id, { updated_at: input.base_updated_at, viewer_key: input.base_viewer_key }, viewer)
    }),

  createStory: content_admin_procedure
    .input(api_schema.content.create_story)
    .mutation(async ({ ctx, input }) => ({
      id: await create_story(ctx.auth_user.id, input.markdown, has_permission(ctx.auth_user, 'content_private', 'read')),
    })),

  updateStory: content_admin_procedure
    .input(api_schema.content.update_story)
    .mutation(async ({ ctx, input }) => {
      return update_story(
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

  signAttachmentUpload: content_admin_procedure
    .input(api_schema.content.sign_attachment_upload)
    .mutation(({ input }) => sign_attachment_upload(input)),

  // Signing grants nothing the nameless object URL doesn't already grant — the
  // signature only names the download — so viewers sign directly.
  signAttachmentDownload: public_procedure
    .input(api_schema.content.sign_attachment_download)
    .mutation(({ input }) => sign_attachment_download(input.story_id, input.file_name)),

  confirmAttachmentUpload: content_admin_procedure
    .input(api_schema.content.confirm_attachment_upload)
    .mutation(({ input }) => confirm_attachment_upload(input.story_id, input.key, input.file_name)),

  renameAttachment: content_admin_procedure
    .input(api_schema.content.rename_attachment)
    .mutation(({ input }) => rename_attachment(
      input.id,
      input.old_file_name,
      input.file_name,
    )),

  replaceAttachment: content_admin_procedure
    .input(api_schema.content.replace_attachment)
    .mutation(({ input }) => replace_attachment(
      input.story_id,
      input.old_file_name,
      input.key,
      input.file_name,
      input.content_type,
      input.mode,
    )),

  deleteAttachment: content_admin_procedure
    .input(api_schema.content.delete_attachment)
    .mutation(({ ctx, input }) => delete_attachment(
      input.id,
      input.file_name,
      input.markdown,
      input.base_revision,
      has_permission(ctx.auth_user, 'content_private', 'read'),
    )),

  moveAttachment: content_admin_procedure
    .input(api_schema.content.move_attachment)
    .mutation(({ input }) => move_attachment(
      input.id,
      input.file_name,
      input.target_folder,
    )),

  moveAttachments: content_admin_procedure
    .input(api_schema.content.move_attachments)
    .mutation(({ input }) => move_attachments(
      input.id,
      input.moves,
    )),

  encryptAttachments: content_admin_procedure
    .input(api_schema.content.encrypt_attachments)
    .mutation(({ input }) => encrypt_attachments(input.id, input.file_names)),

  decryptAttachments: content_admin_procedure
    .input(api_schema.content.decrypt_attachments)
    .mutation(({ input }) => decrypt_attachments(input.id, input.file_names)),

  createAbridgedAttachment: content_admin_procedure
    .input(api_schema.content.create_abridged_attachment)
    .mutation(({ input }) => {
      const story_id = z.coerce.number().int().positive().parse(input.get('story_id'))
      const source_file_name = z.string().min(1).max(255).parse(input.get('source_file_name'))
      return create_abridged_attachment(story_id, source_file_name, input)
    }),

  createFolder: content_admin_procedure
    .input(api_schema.content.create_folder)
    .mutation(({ input }) => create_folder(input.id, input.folder)),

  deleteFolder: content_admin_procedure
    .input(api_schema.content.delete_folder)
    .mutation(({ input }) => delete_folder(input.id, input.folder)),

  moveFolder: content_admin_procedure
    .input(api_schema.content.move_folder)
    .mutation(({ input }) => move_folder(
      input.id,
      input.source_folder,
      input.new_folder,
    )),

  getBilibiliVideoCards: public_procedure
    .input(api_schema.content.get_bilibili_video_cards)
    .query(({ input }) => get_bilibili_video_cards(input.hrefs)),
})
