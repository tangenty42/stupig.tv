import { argon2, randomBytes, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'

const derive_key = promisify(argon2)
const costs = { memory: 19456, passes: 2, parallelism: 1, tagLength: 32 }
const salt_length = 16
const hash_prefix = `$argon2id$v=19$m=${costs.memory},t=${costs.passes},p=${costs.parallelism}$`

function encode_phc(bytes: Buffer) {
  return bytes.toString('base64').replace(/=+$/, '')
}

export async function hash_password(password: string) {
  const nonce = randomBytes(salt_length)
  const key = await derive_key('argon2id', { ... costs, message: password, nonce })
  return `${hash_prefix}${encode_phc(nonce)}$${encode_phc(key)}`
}

export async function verify_password(password: string, hash: string) {
  // Use the parameters defined for this format, so malformed storage cannot
  // request unbounded memory or passes from the native KDF.
  if (! hash.startsWith(hash_prefix))
    return false
  const parts = /^([a-z\d+/]{22})\$([a-z\d+/]{43})$/i.exec(hash.slice(hash_prefix.length))
  if (! parts)
    return false
  const nonce = Buffer.from(parts[1]!, 'base64')
  const expected_key = Buffer.from(parts[2]!, 'base64')
  const actual_key = await derive_key('argon2id', { ... costs, message: password, nonce })
  return timingSafeEqual(actual_key, expected_key)
}
