import { createError, defineEventHandler } from 'h3'

/** Retired endpoint: legacy ciphertext and private-bucket redirects are never served. */
export default defineEventHandler(() => {
  throw createError({ statusCode: 410, statusMessage: 'Legacy attachment endpoint retired' })
})
