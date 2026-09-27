import { describe, expect, it } from 'vitest'
import { decrypt_attachment, encrypt_attachment } from './attachment-crypto'

describe('attachment crypto', () => {
  it('round-trips plaintext through AES-256-GCM', () => {
    const plain = new TextEncoder().encode('机密附件内容 secret bytes \u0000\u0001')

    const { key, data } = encrypt_attachment(plain)
    const decrypted = decrypt_attachment(data, key)

    expect(decrypted).toEqual(plain)
    expect(data).not.toEqual(plain)
  })

  it('prefixes a 12-byte IV and appends a 16-byte tag', () => {
    const plain = new Uint8Array(100)

    const { data } = encrypt_attachment(plain)

    expect(data.length).toBe(12 + 100 + 16)
  })

  it('rejects the wrong key', () => {
    const { data } = encrypt_attachment(new TextEncoder().encode('x'))
    const { key: other_key } = encrypt_attachment(new TextEncoder().encode('y'))

    expect(() => decrypt_attachment(data, other_key)).toThrow()
  })

  it('rejects tampered ciphertext', () => {
    const { key, data } = encrypt_attachment(new TextEncoder().encode('payload'))
    data[20]! ^= 0xFF

    expect(() => decrypt_attachment(data, key)).toThrow()
  })
})
