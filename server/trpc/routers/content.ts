import type { ContentWorkspaceCommandResult } from '@shared/types/content'
import { ApiError } from '@server/errors/ApiError'
import { require_auth_user } from '@server/services/auth-guards.service'
import {
  create_story,
  delete_story,
  get_story_body,
  list_stories,
  sign_attachment_download,
  update_story,
} from '@server/services/content.service'
import { image_editor_source } from '@server/services/content/attachment-access.service'
import { get_attachment_workspace } from '@server/services/content/attachment-workspace.service'
import { get_title_reference_version, rewrite_draft_references } from '@server/services/content/reference-history.service'
import { adopt_upload_session, begin_upload_batch, list_upload_sessions, operate_upload_session, sign_upload_session_part } from '@server/services/content/upload-api.service'
import { execute_workspace_command } from '@server/services/content/workspace-command.service'
import { permission_procedure, public_procedure, router } from '@server/trpc/init'
import { api_schema } from '@server/trpc/schemas'
import { upload_batch_schema } from '@shared/content-upload'
import { workspace_command_schema } from '@shared/content-workspace'
import { has_permission } from '@shared/permissions'

const content_admin_procedure = permission_procedure('content_manage', 'full')

export const content_router = router({
  imageEditorSource: content_admin_procedure.input(api_schema.content.image_editor_source)
    .query(({ ctx, input }) => image_editor_source(input.id, input.version, ctx.auth_user, input.redacted)),
  executeWorkspaceCommand: content_admin_procedure.input(workspace_command_schema)
    .mutation(async ({ ctx, input }): Promise<ContentWorkspaceCommandResult> => {
      const report = await execute_workspace_command(ctx.auth_user.id, input)
      // Read after commit (including receipt replay), never cache a viewer's
      // projection in the command receipt or wait for outbox delivery here.
      const workspace = await get_attachment_workspace(input.scope_id, ctx.auth_user)
      return { ... report, workspace }
    }),
  beginUploadBatch: content_admin_procedure.input(upload_batch_schema)
    .mutation(({ ctx, input }) => begin_upload_batch(ctx.auth_user.id, input)),
  listUploadSessions: content_admin_procedure.input(api_schema.content.get_attachment_workspace)
    .query(({ ctx, input }) => list_upload_sessions(input.id, ctx.auth_user.id)),
  adoptUploadSession: content_admin_procedure.input(api_schema.content.upload_session)
    .mutation(({ ctx, input }) => adopt_upload_session(input.session_id, ctx.auth_user.id)),
  getUploadSession: content_admin_procedure.input(api_schema.content.upload_session)
    .query(({ ctx, input }) => operate_upload_session('get', input.session_id, ctx.auth_user.id)),
  initializeUploadSession: content_admin_procedure.input(api_schema.content.upload_session)
    .mutation(({ ctx, input }) => operate_upload_session('initialize', input.session_id, ctx.auth_user.id)),
  resumeUploadSession: content_admin_procedure.input(api_schema.content.upload_session)
    .mutation(({ ctx, input }) => operate_upload_session('resume', input.session_id, ctx.auth_user.id)),
  sealUploadSession: content_admin_procedure.input(api_schema.content.upload_session)
    .mutation(({ ctx, input }) => operate_upload_session('seal', input.session_id, ctx.auth_user.id)),
  cancelUploadSession: content_admin_procedure.input(api_schema.content.upload_session)
    .mutation(({ ctx, input }) => operate_upload_session('cancel', input.session_id, ctx.auth_user.id)),
  signUploadSessionPart: content_admin_procedure.input(api_schema.content.upload_session_part)
    .mutation(({ ctx, input }) => sign_upload_session_part(input.session_id, ctx.auth_user.id, input.part, input.md5)),
  listStories: public_procedure.query(() => list_stories()),
  getTitleReferenceVersion: public_procedure.query(() => get_title_reference_version()),
  getStoryBody: public_procedure
    .input(api_schema.content.get_story_body)
    .query(async ({ ctx, input }) => {
      let viewer = null
      try {
        viewer = await require_auth_user(ctx.event)
      }
      catch {
        viewer = null
      }
      return get_story_body(input.id, viewer, input.base_representation_version)
    }),
  getAttachmentWorkspace: public_procedure
    .input(api_schema.content.get_attachment_workspace)
    .query(async ({ ctx, input }) => {
      let viewer = null
      try {
        viewer = await require_auth_user(ctx.event)
      }
      catch {
        viewer = null
      }
      return get_attachment_workspace(input.id, viewer)
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
        input.base_revision,
        has_permission(ctx.auth_user, 'content_private', 'read'),
        { base_namespace_revision: input.base_namespace_revision, base_title_revision: input.base_title_revision },
        input.confirm_reference_history,
      )
    }),

  deleteStory: content_admin_procedure
    .input(api_schema.content.delete_story)
    .mutation(({ ctx, input }) => delete_story(input.id, ctx.auth_user.id)),

  rewriteDraftReferences: content_admin_procedure
    .input(api_schema.content.rewrite_draft_references)
    .mutation(({ ctx, input }) => rewrite_draft_references(input.id, input.markdown, input, has_permission(ctx.auth_user, 'content_private', 'read'))),

  // Ordinary downloads are public at the application layer; confidential rows
  // and every ancestor archive are authorized by the download service.
  signAttachmentDownload: public_procedure
    .input(api_schema.content.sign_attachment_download)
    .mutation(async ({ ctx, input }) => {
      let viewer = null
      try {
        viewer = await require_auth_user(ctx.event)
      }
      catch (error) {
        if (! (error instanceof ApiError) || error.statusCode !== 401)
          throw error
      }
      return sign_attachment_download(input.story_id, input.file_name, viewer, input.role)
    }),

})
