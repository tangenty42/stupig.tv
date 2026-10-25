import { describe, expect, it } from 'vitest'
import { image_presentation } from './image-presentation'

const row = { is_private: true, image_revision: 2, image_metadata: { width: 40, height: 30 }, lqip_jpeg: Buffer.from([255, 216, 255, 217]), avif_key: 'a', jpeg_key: 'b', object_key: 'a' }
describe('authorized image presentation', () => {
  it('omits the entire private presentation before parsing metadata', () => {
    expect(image_presentation({ ... row, image_metadata: 'invalid-private-json' }, false)).toBeUndefined()
    expect(image_presentation(row, true)).toEqual({ revision: 2, width: 40, height: 30, lqip: 'data:image/jpeg;base64,/9j/2Q==', has_original: false })
    expect(image_presentation({ ... row, is_private: false }, false)?.lqip).toBeTruthy()
  })
  it('distinguishes an owned original archive from an ancestor reference', () => {
    expect(image_presentation({ ... row, original_key: 'own-archive' }, true)).toMatchObject({ has_original: true })
    expect(image_presentation({ ... row, original_key: null, image_metadata: { ... row.image_metadata, archive_source_id: 7, archive_source_key: 'ancestor-archive' } }, true)).toMatchObject({ has_original: false })
  })
  it('never projects incomplete/stale roles or invalid JPEG bytes', () => {
    expect(image_presentation({ ... row, object_key: 'old' }, true)).toBeUndefined()
    expect(image_presentation({ ... row, jpeg_key: null }, true)).toBeUndefined()
    expect(image_presentation({ ... row, image_metadata: { width: 0, height: 2 } }, true)).toBeUndefined()
    expect(image_presentation({ ... row, lqip_jpeg: Buffer.from('invalid') }, true)?.lqip).toBeNull()
    expect(image_presentation({ ... row, lqip_jpeg: Buffer.alloc(8193) }, true)?.lqip).toBeNull()
  })
})
