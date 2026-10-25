import { expect, it } from 'vitest'
import { render_story_cover } from './story-cover'

const image = { revision: 1, width: 120, height: 80, lqip: 'data:image/jpeg;base64,/9j/2Q==', has_original: false }
it('reserves natural dimensions and uses the existing load-state contract for the shared cover', () => {
  const html = render_story_cover('/image?x=1&y=2', 'a"<b>', image)
  expect(html).toContain('width="120" height="80"')
  expect(html).toContain('data-lqip style="--content-lqip:url(data:image/jpeg;base64,/9j/2Q==)"')
  expect(html).toContain('aria-busy="true"')
  expect(html).toContain('src="/image?x=1&amp;y=2"')
  expect(html).toContain('alt="a&quot;&lt;b&gt;"')
  expect(html).not.toContain('loading="lazy"')
})
it('does not embed untrusted LQIP or invalid dimensions and handles missing and raw covers', () => {
  const html = render_story_cover('/raw.gif', 'raw', { ... image, width: 0, lqip: '");color:red' })
  expect(html).not.toContain('data-lqip')
  expect(html).not.toContain('width=')
  expect(html).toContain('image-loading-mask')
  expect(render_story_cover(undefined, 'missing', image)).toContain('data-image-error')
  expect(render_story_cover(undefined, 'missing', image)).not.toContain('data-lqip')
  expect(render_story_cover('/image', 'cover', image, true)).toContain('content-cover-constrained')
})
