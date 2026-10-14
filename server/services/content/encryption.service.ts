import { ApiError } from '@server/errors/ApiError'
import { decrypt_attachment, encrypt_attachment } from '@server/lib/attachment-crypto'

/**
 * Attachment encryption transform (docs/old/content-task-refactor.md §13.1).
 *
 * The batch orchestration lives in the task executor
 * (content/task-operations.service.ts); this module owns the one thing that
 * cannot be task-shaped: the whole-buffer byte transform itself. It is
 * deliberately not streaming — AES-GCM authenticates the buffer as one tag, so
 * a chunked format would be a different ciphertext and every stored object
 * would have to be re-encoded (决策 2).
 */

/**
 * Encrypts or decrypts one attachment's bytes in memory.
 *
 * `file_name` only feeds the failure message; the key comes from the row. A
 * decrypt of corrupt or wrongly-keyed data fails authentication and surfaces
 * as a 409 the task executor records as the item's skip reason.
 */
export function transform_attachment_encryption_bytes(
  kind: 'encrypt' | 'decrypt',
  data: Uint8Array,
  encryption_key: string | null,
  file_name: string,
): { data: Uint8Array, encryption_key: string | null } {
  if (kind === 'encrypt') {
    const { key, data: transformed } = encrypt_attachment(data)
    return { data: transformed, encryption_key: key }
  }
  if (! encryption_key)
    throw new ApiError(409, '附件缺少密钥，无法解密')
  try {
    return { data: decrypt_attachment(data, encryption_key), encryption_key: null }
  }
  catch {
    throw new ApiError(409, `附件解密失败：${file_name}`)
  }
}
