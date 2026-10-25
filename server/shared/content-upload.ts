import { settings } from '@shared/settings'
import { z } from 'zod'
import { attachment_mime_type, decrypted_attachment_name } from './content-markdown'
import { error_policy_schema, workspace_target_schema } from './content-workspace'

export const image_save_mode_schema = z.enum(['copy', 'overwrite', 'redacted'])
export type ImageSaveMode = z.infer<typeof image_save_mode_schema>
const image_source_schema = z.strictObject({ id: z.number().int().positive(), revision: z.number().int().positive(), node_revision: z.number().int().positive(), key: z.string().min(1).max(512), is_private: z.boolean() })
const mime_type_schema = z.string().min(1).max(255).regex(/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/)
export const upload_intent_schema = z.strictObject({
  scope_id: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), operation: z.literal('upload'),
  target_path: z.string().min(1).max(255), target_location: z.literal('aliyun'), target_access: z.enum(['public', 'private']),
  expected_size: z.number().int().positive().max(settings.app.content.upload.maxSizeMb * 1024 ** 2),
  sha256: z.string().regex(/^[\da-f]{64}$/),
  mime_type: mime_type_schema.optional(),
  purpose: z.enum(['create', 'replace', 'redact']).default('create'),
  target_parent_id: z.number().int().positive().optional(),
  target_name: z.string().min(1).optional(),
  source: workspace_target_schema.optional(),
  replacement: workspace_target_schema.optional(),
  redacted_policy: z.enum(['keep', 'discard']).optional(),
  image: z.strictObject({ mode: z.enum(['upload', 'copy', 'overwrite', 'redacted']), source: image_source_schema.nullable(), original_name: z.string().min(1).max(255), original_mime: z.string().min(1).max(255), input_basis: z.enum(['avif', 'original']).optional(), redacted_policy: z.enum(['keep', 'discard']).optional() }).optional(),
})
export const upload_batch_schema = z.strictObject({
  request_id: z.uuid(), scope_id: z.number().int().positive(),
  on_error: error_policy_schema.default(() => error_policy_schema.parse({})),
  entries: z.array(z.strictObject({
    path: z.string().max(4096), size: z.number().int().nonnegative(), sha256: z.string().regex(/^[\da-f]{64}$/),
    purpose: z.enum(['create', 'replace', 'redact']).default('create'), access: z.enum(['public', 'private']).default('public'),
    source: workspace_target_schema.optional(), replacement: workspace_target_schema.optional(),
    image_mode: image_save_mode_schema.optional(),
    image_input_basis: z.enum(['avif', 'original']).optional(),
    original_name: z.string().min(1).max(255).optional(),
    content_type: z.string().max(255).optional(),
    selection_root: z.string().min(1).max(4096).optional(),
  }).refine(entry => ! entry.selection_root || (entry.purpose === 'create' && entry.path.startsWith(`${entry.selection_root}/`)), '所选目录与文件路径不一致')
    .refine(entry => entry.image_mode
      ? !! entry.source && ! entry.replacement && ! entry.selection_root && entry.purpose === ({ copy: 'create', overwrite: 'replace', redacted: 'redact' } as const)[entry.image_mode]
      : entry.purpose === 'create' ? ! entry.source && ! entry.replacement : !! entry.source && (entry.purpose === 'redact' || ! entry.replacement), '上传操作的源目标不一致'))
    .min(1).max(settings.app.content.workspace.batchLimit),
}).refine(batch => batch.entries.every(entry => entry.purpose === batch.entries[0]?.purpose), '同一批次只能包含一种操作')
export type UploadBatch = z.infer<typeof upload_batch_schema>

/** The selected file, never a replacement's retained logical extension, owns its type. */
export function upload_content_mime(entry: Pick<UploadBatch['entries'][number], 'original_name' | 'path' | 'content_type'>) {
  const declared = entry.content_type?.split(';')[0]?.trim().toLowerCase()
  return mime_type_schema.safeParse(declared).success && declared !== 'application/octet-stream' ? declared! : attachment_mime_type(decrypted_attachment_name(entry.original_name ?? entry.path))
}
export const upload_begin_schema = z.strictObject({ request_id: z.uuid(), intent: upload_intent_schema })
export const upload_session_schema = z.strictObject({ session_id: z.string().regex(/^[\da-f]{32}$/) })
export const upload_part_schema = upload_session_schema.extend({ part: z.number().int().min(1).max(10_000), md5: z.string().regex(/^[A-Z0-9+/]{22}==$/i) })

export function redaction_image_mime(data: Uint8Array) {
  const starts = (... bytes: number[]) => bytes.every((value, index) => data[index] === value)
  if (starts(0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A))
    return 'image/png'
  if (starts(0xFF, 0xD8, 0xFF))
    return 'image/jpeg'
  if (starts(0x42, 0x4D))
    return 'image/bmp'
  if (starts(0x52, 0x49, 0x46, 0x46) && data[8] === 0x57 && data[9] === 0x45 && data[10] === 0x42 && data[11] === 0x50)
    return 'image/webp'
  return null
}
