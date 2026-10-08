import { require_auth_user } from '@server/services/auth-guards.service'
import { get_bilibili_video_cards } from '@server/services/bilibili.service'
import {
  create_abridged_attachment,
  create_story,
  decrypt_attachments,
  delete_story,
  encrypt_attachments,
  get_story,
  list_stories,
  sign_attachment_download,
  update_story,
} from '@server/services/content.service'
import { cancel_content_task, create_content_task, create_folder, delete_attachment, delete_folder, move_attachment, move_attachments, move_folder, rename_attachment, report_task_item, resume_content_task, resume_task_item, sign_task_parts } from '@server/services/content/task-api.service'
import { preflight_task } from '@server/services/content/task-operations.service'
import { list_scope_tasks } from '@server/services/content/task.service'
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

  // Signing grants nothing the nameless object URL doesn't already grant — the
  // signature only names the download — so viewers sign directly.
  signAttachmentDownload: public_procedure
    .input(api_schema.content.sign_attachment_download)
    .mutation(({ input }) => sign_attachment_download(input.story_id, input.file_name)),

  renameAttachment: content_admin_procedure
    .input(api_schema.content.rename_attachment)
    .mutation(({ ctx, input }) => rename_attachment(
      input.id,
      input.old_file_name,
      input.file_name,
      ctx.auth_user.id,
    )),

  deleteAttachment: content_admin_procedure
    .input(api_schema.content.delete_attachment)
    .mutation(({ ctx, input }) => delete_attachment(
      input.id,
      input.file_name,
      input.markdown,
      input.base_revision,
      has_permission(ctx.auth_user, 'content_private', 'read'),
      ctx.auth_user.id,
    )),

  moveAttachment: content_admin_procedure
    .input(api_schema.content.move_attachment)
    .mutation(({ ctx, input }) => move_attachment(
      input.id,
      input.file_name,
      input.target_folder,
      ctx.auth_user.id,
    )),

  moveAttachments: content_admin_procedure
    .input(api_schema.content.move_attachments)
    .mutation(({ ctx, input }) => move_attachments(
      input.id,
      input.moves,
      ctx.auth_user.id,
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
    .mutation(({ ctx, input }) => create_folder(input.id, input.folder, ctx.auth_user.id)),

  deleteFolder: content_admin_procedure
    .input(api_schema.content.delete_folder)
    .mutation(({ ctx, input }) => delete_folder(input.id, input.folder, ctx.auth_user.id)),

  moveFolder: content_admin_procedure
    .input(api_schema.content.move_folder)
    .mutation(({ ctx, input }) => move_folder(
      input.id,
      input.source_folder,
      input.new_folder,
      ctx.auth_user.id,
    )),

  getBilibiliVideoCards: public_procedure
    .input(api_schema.content.get_bilibili_video_cards)
    .query(({ input }) => get_bilibili_video_cards(input.hrefs)),

  /* ---- 附件任务队列（docs/content-task-refactor.md §7）---- */

  preflightTask: content_admin_procedure
    .input(api_schema.content.preflight_task)
    .query(({ input }) => preflight_task(input.story_id, input.kind, input.payload)),

  createTask: content_admin_procedure
    .input(api_schema.content.create_task)
    .mutation(({ ctx, input }) => create_content_task({
      scope_id: input.story_id,
      kind: input.kind,
      payload: input.payload,
      actor_id: ctx.auth_user.id,
      client_id: input.client_id ?? null,
    })),

  cancelTask: content_admin_procedure
    .input(api_schema.content.cancel_task)
    .mutation(({ input }) => cancel_content_task(input.task_id)),

  resumeTask: content_admin_procedure
    .input(api_schema.content.resume_task)
    .mutation(({ input }) => resume_content_task(input.task_id)),

  listScopeTasks: content_admin_procedure
    .input(api_schema.content.list_scope_tasks)
    .query(({ input }) => list_scope_tasks(input.story_id)),

  /* ---- 传输段（上传任务专用）---- */

  signTaskParts: content_admin_procedure
    .input(api_schema.content.sign_task_parts)
    .mutation(({ input }) => sign_task_parts(input)),

  reportTaskItem: content_admin_procedure
    .input(api_schema.content.report_task_item)
    .mutation(({ input }) => report_task_item(input)),

  resumeTaskItem: content_admin_procedure
    .input(api_schema.content.resume_task_item)
    .query(({ input }) => resume_task_item(input)),
})
