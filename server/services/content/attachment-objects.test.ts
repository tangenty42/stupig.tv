import { expect, it } from 'vitest'
import { attachment_owned_object_keys } from './attachment-objects'

it('collects the archive and both current roles once without pinning a parent AVIF', () => {
  const row = { object_key: 'avif', original_key: 'archive', avif_key: 'avif', jpeg_key: 'jpeg', parent_avif_key: 'parent' }
  expect(attachment_owned_object_keys(row)).toEqual(['avif', 'archive', 'jpeg'])
  expect(attachment_owned_object_keys({ object_key: 'ordinary' })).toEqual(['ordinary'])
  expect(attachment_owned_object_keys({ object_key: null })).toEqual([])
})
