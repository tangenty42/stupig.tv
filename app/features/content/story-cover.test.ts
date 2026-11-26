import { expect, it } from 'vitest'
import { render_story_cover } from './story-cover'

const image = { revision: 1, width: 120, height: 80, lqip: 'data:image/jpeg;base64,/9j/2Q==', has_original: false }
it('reserves natural dimensions and uses the existing load-state contract for the shared cover', () => {
  const html = render_story_cover('/image?x=1&y=2', 'a"<b>', image, 1024, true)
  expect(html).toContain('width="120" height="80"')
  expect(html).toContain('data-lqip data-image-sized style="--content-lqip:url(data:image/jpeg;base64,/9j/2Q==);--content-image-width:120px;--content-image-ratio:1.5"')
  expect(html).toContain('aria-busy="true"')
  expect(html).toContain('<span class="image-lqip" aria-hidden="true"></span>')
  expect(html).toContain('src="/image?x=1&amp;y=2"')
  expect(html).toContain('alt="a&quot;&lt;b&gt;"')
  expect(html).toContain('loading="lazy"')
  expect(html).toContain('class="image-unavailable" role="img" aria-label="图片加载失败"')
})
it('does not embed untrusted LQIP or invalid dimensions and handles missing and raw covers', () => {
  const html = render_story_cover('/raw.gif', 'raw', { ... image, width: 0, lqip: '");color:red' }, 1024)
  expect(html).not.toContain('data-lqip')
  expect(html).not.toContain('image-lqip')
  expect(html).not.toContain('width=')
  expect(html).not.toContain('data-image-sized')
  expect(html).not.toContain('--content-image-')
  expect(html).toContain('image-loading-mask')
  expect(render_story_cover(undefined, 'missing', image, 1024)).toContain('data-image-error')
  expect(render_story_cover(undefined, 'missing', image, 1024)).not.toContain('data-lqip')
  expect(render_story_cover(undefined, 'missing', image, 1024)).not.toContain('data-image-sized')
  expect(render_story_cover('/image', 'cover', image, 1024, true)).toContain('content-cover-constrained')
})

it.each([null, 'data:image/jpeg;base64,/9j/2Q=='])('reserves constrained cover geometry even without a usable LQIP (%s)', (lqip) => {
  const html = render_story_cover('/image', 'cover', { ... image, width: 800, height: 320, lqip }, 0, true)
  expect(html).not.toContain('data-lqip')
  expect(html).toContain('data-image-sized style="--content-image-width:800px;--content-image-ratio:2.5"')
  expect(html).toContain('width="800" height="320"')
})

it.each([
  [2400, 800, 3],
  [800, 2400, 1 / 3],
  [24, 16, 1.5],
])('reserves the actual %s by %s aspect without imposing a square minimum', (width, height, ratio) => {
  const html = render_story_cover('/image', 'cover', { ... image, width, height }, 1024, true)
  expect(html).toContain(`--content-image-width:${width}px;--content-image-ratio:${ratio}`)
})
