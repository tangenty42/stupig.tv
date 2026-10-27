import * as z from 'zod'
import { public_api_error_schema } from './api-error'

export const reference_safety_code_schema = z.literal('REF_HISTORY_UNAVAILABLE')
export type ReferenceSafetyCode = z.infer<typeof reference_safety_code_schema>

const application_error_schema = z.union([
  public_api_error_schema,
  z.strictObject({ code: reference_safety_code_schema, details: z.undefined().optional() }),
])
export type ApplicationError = z.infer<typeof application_error_schema>

export function parse_application_error(value: unknown) {
  const parsed = application_error_schema.safeParse(value)
  return parsed.success ? parsed.data : undefined
}
