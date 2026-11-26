import * as z from 'zod'
import { privacy_change_schema, privacy_digest_schema, workspace_issue_schema } from './content-workspace'
import { settings } from './settings'

/** Only explicitly declared public error data may cross the transport boundary. */
export const public_api_error_schema = z.discriminatedUnion('code', [z.strictObject({
  code: z.literal('UPLOAD_SESSION_EXPIRED'),
  details: z.undefined().optional(),
}), z.strictObject({
  code: z.literal('ADMIN_TARGET_REJECTED'),
  details: z.undefined().optional(),
}), z.strictObject({
  code: z.literal('REF_TARGET_REPLACED'),
  details: z.strictObject({
    namespace_revision: z.number().int().nonnegative(),
    title_revision: z.number().int().nonnegative(),
    references: z.array(z.strictObject({
      kind: z.enum(['attachment', 'story']),
      target: z.string(), from: z.number().int().nonnegative(), to: z.number().int().nonnegative(),
      line: z.number().int().positive(), reason: z.literal('replaced'),
    })).min(1),
  }),
}), z.strictObject({
  code: z.literal('BATCH_REJECTED'),
  // Older receipts may still include group_targets; new responses only need items and valid_count.
  details: z.strictObject({ items: z.array(workspace_issue_schema).min(1).max(500), valid_count: z.number().int().nonnegative(), group_targets: z.array(z.string()).max(settings.app.content.workspace.batchLimit).optional() }),
}), z.strictObject({
  code: z.literal('PRIVACY_CONFIRMATION'),
  details: z.strictObject({ changes: z.array(privacy_change_schema).min(1), total: z.number().int().positive(), digest: privacy_digest_schema })
    .refine(({ changes, total }) => changes.length === total),
})])

export type PublicApiError = z.infer<typeof public_api_error_schema>

export function parse_public_api_error(value: unknown) {
  const parsed = public_api_error_schema.safeParse(value)
  return parsed.success ? parsed.data : undefined
}
