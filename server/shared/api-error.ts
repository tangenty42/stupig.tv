import * as z from 'zod'
import { workspace_issue_schema } from './content-workspace'

/** Only explicitly declared public error data may cross the transport boundary. */
export const public_api_error_schema = z.discriminatedUnion('code', [z.strictObject({
  code: z.literal('UPLOAD_SESSION_EXPIRED'),
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
  details: z.strictObject({ items: z.array(workspace_issue_schema).min(1).max(500), valid_count: z.number().int().nonnegative(), valid_targets: z.array(z.string()).optional() }),
})])

export type PublicApiError = z.infer<typeof public_api_error_schema>

export function parse_public_api_error(value: unknown) {
  const parsed = public_api_error_schema.safeParse(value)
  return parsed.success ? parsed.data : undefined
}
