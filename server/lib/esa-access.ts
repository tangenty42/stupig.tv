import { z } from 'zod'

/** Public identifiers only; the URL signature authenticates this read grant. */
export const esa_read_grant = z.strictObject({
  id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  revision: z.string().regex(/^[a-f\d]{64}$/),
  role: z.enum(['auto', 'avif', 'jpeg', 'original', 'redacted_avif', 'redacted_jpeg', 'redacted']),
  session: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  generation: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).refine(value => (value.session === 0) === (value.generation === 0), 'Session and generation must be bound together')
export type EsaReadGrant = z.infer<typeof esa_read_grant>

export function encode_esa_read_grant(grant: EsaReadGrant) {
  return Buffer.from(JSON.stringify(esa_read_grant.parse(grant))).toString('base64url')
}

export function decode_esa_read_grant(access: string) {
  if (! /^[\w-]{1,2048}$/.test(access))
    throw new Error('Invalid read grant')
  const bytes = Buffer.from(access, 'base64url')
  if (bytes.toString('base64url') !== access)
    throw new Error('Invalid read grant encoding')
  return esa_read_grant.parse(JSON.parse(bytes.toString('utf8')))
}
