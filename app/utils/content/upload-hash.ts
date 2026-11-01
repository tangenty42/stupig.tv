import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'

export type UploadHashMessage = { type: 'progress', loaded: number } | { type: 'done', sha256: string } | { type: 'error' }

/** Shared bounded-memory implementation for the worker and compatibility path. */
export async function calculate_upload_sha256(file: Blob, chunk_size: number, signal?: AbortSignal, progress?: (loaded: number) => void) {
  const hash = sha256.create()
  try {
    for (let offset = 0; offset < file.size; offset += chunk_size) {
      signal?.throwIfAborted()
      const bytes = await file.slice(offset, offset + chunk_size).arrayBuffer()
      signal?.throwIfAborted()
      hash.update(new Uint8Array(bytes))
      progress?.(Math.min(offset + chunk_size, file.size))
    }
    signal?.throwIfAborted()
    return bytesToHex(hash.digest())
  }
  finally { hash.destroy() }
}
