import { z } from 'zod'

/** Internal receipt metadata. An empty change is a known no-op, not a legacy receipt. */
export const workspace_change_schema = z.object({
  attachments: z.boolean().optional(),
  story: z.boolean().optional(),
  stories: z.boolean().optional(),
  uploads: z.boolean().optional(),
  upload_sessions: z.array(z.string()).optional(),
})
export type WorkspaceChange = z.infer<typeof workspace_change_schema>

/** Pre-change receipts cannot prove which projections changed; safely invalidate all. */
export const legacy_workspace_change: WorkspaceChange = { attachments: true, story: true, stories: true, uploads: true }
