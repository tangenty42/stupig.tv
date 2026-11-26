import { expect, it } from 'vitest'
import { parse_public_api_error, public_api_error_schema } from './api-error'
import { parse_application_error } from './content-reference-error'

it.each([{ code: 'ADMIN_TARGET_REJECTED' }, { code: 'ADMIN_TARGET_REJECTED', details: undefined }])('accepts a detail-free pre-write admin rejection: %j', (value) => {
  expect(public_api_error_schema.parse(value)).toEqual(value)
  expect(parse_public_api_error(value)).toEqual(value)
  expect(parse_application_error(value)).toEqual(value)
})

it.each([
  { code: 'ADMIN_TARGET_REJECTED', details: null },
  { code: 'ADMIN_TARGET_REJECTED', details: { target_id: 7 } },
  { code: 'ADMIN_TARGET_REJECTED', target_id: 7 },
])('rejects undeclared fields on a pre-write admin rejection: %j', (value) => {
  expect(parse_public_api_error(value)).toBeUndefined()
  expect(parse_application_error(value)).toBeUndefined()
})
