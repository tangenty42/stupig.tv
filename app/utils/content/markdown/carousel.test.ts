// @vitest-environment happy-dom
import type { ContentStoryAttachment, ContentStorySummary } from '@shared/types/content'
import { expect, it } from 'vitest'
import { create_story_markdown } from './index'

const files: ContentStoryAttachment[] = [
  { file_name: 'image.png', mime_type: 'image/png', file_size: 100, version: 'v1', is_image: true, url: '/image' },
  { file_name: 'docs/file.txt', mime_type: 'text/plain', file_size: 200, version: 'v2', is_image: false, url: '/file' },
  { file_name: 'secret.png', mime_type: 'image/png', file_size: 100, version: 'v3', is_image: true, is_private: true, url: '/private' },
]
const story: ContentStorySummary = { id: 2, title: 'Known', labels: [], desc: null, cover: null, cover_label: null, cover_version: null, cover_url: null, event_dates: [], event_precision: 'day', created_at: '', updated_at: '' }

function render(source: string, attachments = files) {
  const md = create_story_markdown({ story_id: () => 1, attachments: () => attachments, folders: () => ['empty'], stories: () => [story], static_url: path => path, folder_card_openable: () => true })
  const env = { images: [] as string[] }
  const root = document.createElement('div')
  root.innerHTML = md.render(source, env)
  return { root, images: env.images, md }
}

it.each(['', ' ', '\n', '  \n'])('groups mixed images, file, folder, story and iframe cards across separator %j', (separator) => {
  const source = ['![**caption**](att://image.png)', '[](att://docs/file.txt)', '[](att://empty)', '[](content://Known)', '![player](iframe://player.bilibili.com/player.html?bvid=123)'].join(separator)
  const { root, images } = render(source)
  const strip = root.querySelector('.image-carousel')!
  expect(root.querySelectorAll('.carousel-shell')).toHaveLength(1)
  expect([... strip.children].map(child => child.classList.contains('carousel-item') ? 'image' : child.classList.contains('story-card') ? 'story' : child.classList.contains('folder-card') ? 'folder' : 'file')).toEqual(['image', 'file', 'folder', 'story', 'image'])
  expect(strip.querySelector('.carousel-caption strong')?.textContent).toBe('caption')
  expect(strip.querySelector('iframe')?.getAttribute('src')).toBe('https://player.bilibili.com/player.html?bvid=123')
  expect(images).toEqual(['/image'])
})

it.each(['![**caption**](att://image.png)', '![**caption**](att://secret.png)', '![**caption**](att://missing.png)', '![**caption**](iframe://player.bilibili.com/player.html?bvid=123)'])('keeps the same complete image item alone, amid prose, and beside a file: %s', (image) => {
  const item = (source: string) => render(source).root.querySelector('.carousel-item')!.outerHTML
  expect(item(`before ${image} after`)).toBe(item(image))
  expect(item(`${image} [](att://docs/file.txt)`)).toBe(item(image))
  const { root, md } = render(`before ${image} after`)
  expect(root.querySelector('.carousel-shell')).toBeNull()
  expect(root.querySelector('p')?.textContent).toContain('before')
  const inline = document.createElement('div')
  inline.innerHTML = md.renderInline(image, { images: [] })
  expect(inline.firstElementChild?.outerHTML).toBe(item(image))
})

it('keeps ordinary prose, formatted link labels, inline HTML and blank-line boundaries intact', () => {
  const { root } = render('before **bold** ![one](att://image.png) [](att://docs/file.txt) after *italic*\n\n[**custom** label](att://docs/file.txt)\n\n<span>![inside](att://image.png) and **text**</span>\n\n![last](att://image.png)')
  expect([... root.children].map(child => child.tagName)).toEqual(['P', 'DIV', 'P', 'P', 'P', 'DIV'])
  expect(root.children[0]?.querySelector('strong')?.textContent).toBe('bold')
  expect(root.children[2]?.querySelector('em')?.textContent).toBe('italic')
  expect(root.children[3]?.querySelector('a strong')?.textContent).toBe('custom')
  expect(root.children[4]?.querySelector('span > .carousel-item .carousel-caption')?.textContent).toBe('inside')
  expect(root.children[4]?.querySelector('span > strong')?.textContent).toBe('text')
  expect(root.querySelectorAll('.carousel-shell')).toHaveLength(2)
})

it.each(['[](att://docs/file.txt)', '[docs/file.txt](att://docs/file.txt)', '[](att://empty)', '[](content://Known)', '[](content://Gone)'])('uses the same card body alone or in a mixed strip: %s', (card) => {
  const single = render(card).root.querySelector('.image-carousel > .link-card')!
  const mixed = render(`${card} ![caption](att://image.png)`).root.querySelector('.image-carousel > .link-card')!
  expect(single).not.toBeNull()
  expect(mixed.innerHTML).toBe(single.innerHTML)
})

it('keeps denied and redacted images captioned without disclosing the private URL or filename', () => {
  const denied = { ... files[2]!, id: 3, url: null }
  const redacted = { ... denied, has_redacted: true, redacted_url: '/redacted', redacted_image: { revision: 1, width: 20, height: 10, lqip: null, has_original: false } }
  for (const file of [denied, redacted]) {
    const source = '![visible **caption**](att://secret.png) [](att://docs/file.txt)'
    const { root, images } = render(source, [files[1]!, file])
    expect(root.querySelector('.image-carousel .carousel-caption strong')?.textContent).toBe('caption')
    expect(root.innerHTML).not.toContain('secret.png')
    expect(root.innerHTML).not.toContain('/private')
    expect(images).toEqual(file === denied ? [] : ['/redacted'])
    expect(Boolean(root.querySelector('.encrypted-image-denied'))).toBe(file === denied)
  }
})

it('groups denied labeled file cards without absorbing neighboring ordinary links', () => {
  const { root } = render('[custom](att://secret.png) [](att://docs/file.txt) [ordinary](https://example.com)', [files[1]!, { ... files[2]!, url: null }])
  expect(root.querySelectorAll('.image-carousel > .link-card')).toHaveLength(2)
  expect(root.querySelector('.image-carousel .encrypted-card-denied')).not.toBeNull()
  expect(root.querySelector('p a')?.textContent).toContain('ordinary')
})
