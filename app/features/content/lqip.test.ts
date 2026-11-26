import type { ContentStoryAttachment } from '@shared/types/content'
import { describe, expect, it } from 'vitest'
import { image_lqip_style } from './lqip'

const file = { url: '/attachment', is_private: false, image: { revision: 1, width: 10, height: 20, lqip: 'data:image/jpeg;base64,/9j/2Q==' } } as ContentStoryAttachment
describe('inline JPEG placeholder', () => {
  it('uses only readable, bounded JPEG data for CSS', () => {
    expect(image_lqip_style(file, 100)).toBe('--content-lqip:url(data:image/jpeg;base64,/9j/2Q==)')
    expect(image_lqip_style(file, 1)).toBeNull()
    expect(image_lqip_style({ ... file, is_private: true, url: null }, 100)).toBeNull()
    expect(image_lqip_style({ ... file, image: { ... file.image!, lqip: 'https://other/secret.jpg' } }, 100)).toBeNull()
    expect(image_lqip_style({ ... file, image: { ... file.image!, lqip: 'data:image/jpeg;base64,");color:red' } }, 100)).toBeNull()
    expect(image_lqip_style({ ... file, image: { ... file.image!, revision: 0 } }, 100)).toBeNull()
  })
})
