import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

// Attachment encryption: AES-256-GCM with a random per-file key (base64 on the
// DB row). Ciphertext layout is [12-byte IV][ciphertext][16-byte auth tag],
// mirrored by the client-side WebCrypto decryption.
const iv_bytes = 12
const tag_bytes = 16

export function encrypt_attachment(plain: Uint8Array) {
  const key = randomBytes(32)
  const iv = randomBytes(iv_bytes)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const data = Buffer.concat([iv, cipher.update(plain), cipher.final(), cipher.getAuthTag()])
  return { key: key.toString('base64'), data: new Uint8Array(data) }
}

/** Throws when the key is wrong or the bytes were tampered with (GCM tag check). */
export function decrypt_attachment(data: Uint8Array, key_b64: string) {
  const key = Buffer.from(key_b64, 'base64')
  const decipher = createDecipheriv('aes-256-gcm', key, data.subarray(0, iv_bytes))
  decipher.setAuthTag(data.subarray(data.length - tag_bytes))
  const plain = Buffer.concat([decipher.update(data.subarray(iv_bytes, data.length - tag_bytes)), decipher.final()])
  return new Uint8Array(plain)
}
