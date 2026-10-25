import type { ContentStoryAttachment } from '@shared/types/content'
import { describe, expect, it } from 'vitest'
import { image_lqip_style, observe_image_placeholders, reset_image_placeholder } from './lqip'

const file = { url: '/attachment', is_private: false, is_encrypted: false, image: { revision: 1, width: 10, height: 20, lqip: 'data:image/jpeg;base64,/9j/2Q==' } } as ContentStoryAttachment
describe('inline JPEG placeholder', () => {
  it('uses only readable, bounded JPEG data for CSS', () => {
    expect(image_lqip_style(file)).toBe('--content-lqip:url(data:image/jpeg;base64,/9j/2Q==)')
    expect(image_lqip_style({ ... file, is_private: true, url: null })).toBeNull()
    expect(image_lqip_style({ ... file, image: { ... file.image!, lqip: 'https://other/secret.jpg' } })).toBeNull()
    expect(image_lqip_style({ ... file, image: { ... file.image!, lqip: 'data:image/jpeg;base64,");color:red' } })).toBeNull()
    expect(image_lqip_style({ ... file, image: { ... file.image!, revision: 0 } })).toBeNull()
  })
})

function image_boundary(complete = false, naturalWidth = 0, lqip = false) {
  const attributes = new Map<string, string>()
  const frame = { dataset: {} as Record<string, string>, setAttribute: (key: string, value: string) => attributes.set(key, value), removeAttribute: (key: string) => attributes.delete(key) }
  const image = Object.assign(new EventTarget(), { complete, naturalWidth, parentElement: frame })
  if (lqip)
    frame.dataset.lqip = ''
  // Only substitute the native DOM boundary. The selector must include raw
  // GIF/SVG frames as well as frames with a version-bound JPEG placeholder.
  const root = { querySelectorAll: (selector: string) => selector === '.img-frame > img' || (lqip && selector === '.img-frame[data-lqip] > img') ? [image] : [] }
  return { image, frame, attributes, root: root as unknown as HTMLElement }
}

it.each([false, true])('tracks loading, error, representation changes and cleanup with LQIP=%s', (lqip) => {
  const { image, frame, attributes, root } = image_boundary(false, 0, lqip)
  const cleanup = observe_image_placeholders(root)
  expect(attributes.get('aria-busy')).toBe('true')
  expect(frame.dataset.imageLoaded).toBeUndefined()
  image.naturalWidth = 120
  image.dispatchEvent(new Event('load'))
  expect(frame.dataset.imageLoaded).toBe('')
  expect(attributes.has('aria-busy')).toBe(false)
  reset_image_placeholder(image as unknown as HTMLImageElement)
  expect(frame.dataset.imageLoaded).toBeUndefined()
  expect(attributes.get('aria-busy')).toBe('true')
  image.dispatchEvent(new Event('error'))
  expect(frame.dataset.imageError).toBe('')
  expect(attributes.has('aria-busy')).toBe(false)
  cleanup()
  image.dispatchEvent(new Event('load'))
  expect(frame.dataset.imageLoaded).toBeUndefined()
  expect(frame.dataset.imageError).toBe('')
})

it.each([0, 120])('settles already-complete images before hydration with natural width %s', (width) => {
  const { frame, attributes, root } = image_boundary(true, width)
  const cleanup = observe_image_placeholders(root)
  expect(frame.dataset[width ? 'imageLoaded' : 'imageError']).toBe('')
  expect(attributes.has('aria-busy')).toBe(false)
  cleanup()
})
