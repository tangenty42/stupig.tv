// Client mirror of server/lib/attachment-crypto.ts: ciphertext layout is
// [12-byte IV][ciphertext][16-byte GCM tag]. WebCrypto's AES-GCM decrypt
// expects ciphertext and tag concatenated, which is exactly what follows
// the IV.

import { reactive } from 'vue'

function base64_to_bytes(base64: string) {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index ++) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}

export async function decrypt_attachment_bytes(data: ArrayBuffer, key_base64: string) {
  const key = await crypto.subtle.importKey('raw', base64_to_bytes(key_base64), 'AES-GCM', false, ['decrypt'])
  return crypto.subtle.decrypt({ name: 'AES-GCM', iv: data.slice(0, 12) }, key, data.slice(12))
}

// Fetched+decrypted blob URLs, keyed by the ciphertext URL (which carries
// ?version=, so a re-encrypted file gets a fresh entry). Module-level: the
// story page and the editor preview share the cache.
const decrypted_blob_cache = new Map<string, Promise<string>>()

/** Ciphertext URLs with an in-flight fetch/decrypt; the UI reads "解密中" from this. */
export const decrypting_urls = reactive(new Set<string>())

// Blob URLs cost memory per decrypted file; cap the cache and revoke the
// oldest entry's URL on evict so a long session cannot accumulate them.
const decrypted_blob_cache_limit = 50

function evict_oldest_blob() {
  const oldest = decrypted_blob_cache.keys().next().value
  if (oldest === undefined) {
    return
  }
  const pending = decrypted_blob_cache.get(oldest)
  decrypted_blob_cache.delete(oldest)
  void pending?.then(url => URL.revokeObjectURL(url)).catch(() => {})
}

/** Fetches the ciphertext at `url` and resolves to a decrypted blob URL. */
export function decrypted_blob_url(url: string, key_base64: string, mime_type: string | null) {
  let cached = decrypted_blob_cache.get(url)
  if (! cached) {
    cached = (async () => {
      const response = await fetch(url)
      if (! response.ok) {
        throw new Error(`下载加密附件失败（HTTP ${response.status}）`)
      }
      const plain = await decrypt_attachment_bytes(await response.arrayBuffer(), key_base64)
      return URL.createObjectURL(new Blob([plain], { type: mime_type ?? undefined }))
    })()
    decrypted_blob_cache.set(url, cached)
    if (decrypted_blob_cache.size > decrypted_blob_cache_limit) {
      evict_oldest_blob()
    }
    decrypting_urls.add(url)
    const clear_decrypting = () => decrypting_urls.delete(url)
    cached.then(clear_decrypting, clear_decrypting)
    // A transient failure must not poison the cache; the next attempt refetches.
    cached.catch(() => decrypted_blob_cache.delete(url))
  }
  return cached
}
