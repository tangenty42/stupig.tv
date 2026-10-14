import * as z from 'zod'

/** Only explicitly declared public error data may cross the transport boundary. */
export const public_api_error_schema = z.strictObject({
  code: z.literal('LEGACY_REF'),
  details: z.strictObject({ lines: z.array(z.number().int().positive()).min(1) }),
})

export type PublicApiError = z.infer<typeof public_api_error_schema>

export function parse_public_api_error(value: unknown) {
  const parsed = public_api_error_schema.safeParse(value)
  return parsed.success ? parsed.data : undefined
}
