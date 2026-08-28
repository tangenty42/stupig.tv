import { randomBytes } from 'node:crypto'

/** Short random cache-bust token (8 bytes, base64url) for file names / versions. */
export function random_file_token() {
  return randomBytes(8).toString('base64url')
}
