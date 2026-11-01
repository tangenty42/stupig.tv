import { expect, it } from 'vitest'
import { attachment_owned_object_keys } from './attachment-objects'

it('collects the archive and both current roles once without pinning a parent WebP', () => {
  const row = { object_key: 'webp', original_key: 'archive', display_key: 'webp', fallback_key: 'jpeg', source_display_key: 'parent' }
  expect(attachment_owned_object_keys(row)).toEqual(['webp', 'archive', 'jpeg'])
  expect(attachment_owned_object_keys({ object_key: 'ordinary' })).toEqual(['ordinary'])
  expect(attachment_owned_object_keys({ object_key: null })).toEqual([])
})
