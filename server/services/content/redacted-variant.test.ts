import { expect, it } from 'vitest'
import { attachment_owned_object_keys } from './attachment-objects'
import { has_redacted_variant, redacted_object_keys, redacted_presentation_row } from './redacted-variant'

it('requires a complete published pair and its revision', () => {
  expect(has_redacted_variant({ redacted_display_key: 'webp', redacted_revision: 1 })).toBe(false)
  expect(has_redacted_variant({ redacted_display_key: 'webp', redacted_fallback_key: 'jpeg', redacted_revision: 0 })).toBe(false)
  expect(has_redacted_variant({ redacted_display_key: 'webp', redacted_fallback_key: 'jpeg', redacted_revision: 2 })).toBe(true)
})

it('selects only the redacted pixels and metadata without changing owner identity', () => {
  const row = { id: 8, is_private: 1, original_key: 'secret-original', object_key: 'secret', display_key: 'secret', fallback_key: 'secret-jpg',
    image_metadata: { width: 4000, height: 3000 }, lqip: Buffer.from('secret'), image_revision: 9,
    redacted_display_key: 'public', redacted_fallback_key: 'public-jpg', redacted_revision: 2,
    redacted_metadata: JSON.stringify({ width: 20, height: 10 }), redacted_lqip: Buffer.from('public') }
  expect(redacted_presentation_row(row)).toMatchObject({ id: 8, is_private: 1, original_key: null, object_key: 'public', display_key: 'public',
    fallback_key: 'public-jpg', image_revision: 2, image_metadata: { width: 20, height: 10 }, lqip: Buffer.from('public') })
  expect(row.original_key).toBe('secret-original')
  expect(redacted_object_keys(row)).toEqual(['public', 'public-jpg'])
  expect(attachment_owned_object_keys(row)).toEqual(['secret', 'secret-original', 'secret-jpg', 'public', 'public-jpg'])
})
