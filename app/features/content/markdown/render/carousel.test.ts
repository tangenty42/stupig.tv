// @vitest-environment happy-dom
import type { ContentStoryAttachment, ContentStorySummary } from '@shared/types/content'
import { redact_private_content } from '@shared/content-private'
import { expect, it } from 'vitest'
import { create_story_markdown } from './index'

const files: ContentStoryAttachment[] = [
  { file_name: 'image.png', mime_type: 'image/png', file_size: 100, version: 'v1', is_image: true, url: '/image' },
  { file_name: 'docs/file.txt', mime_type: 'text/plain', file_size: 200, version: 'v2', is_image: false, url: '/file' },
  { file_name: 'secret.png', mime_type: 'image/png', file_size: 100, version: 'v3', is_image: true, is_private: true, url: '/private' },
]
const story: ContentStorySummary = { id: 2, title: 'Known', labels: [], desc: null, cover: null, cover_label: null, cover_version: null, cover_url: null, event_dates: [], event_precision: 'day', created_at: '', updated_at: '' }

function render(source: string, attachments = files) {
  const md = create_story_markdown({ story_id: () => 1, attachments: () => attachments, folders: () => ['empty'], stories: () => [story], static_url: path => path, lqip_max_bytes: 1024, folder_card_openable: () => true })
  const env = { images: [] as string[] }
  const root = document.createElement('div')
  root.innerHTML = md.render(source, env)
  return { root, images: env.images, md }
}

it.each(['<carousel>one two</carousel>', 'before <carousel>one two</carousel> after'])('keeps the next arrow alongside a two-line first-scroll hint: %s', (source) => {
  const { root } = render(source)
  const next = root.querySelector('.carousel-next')!
  const hint = next.querySelector('.carousel-hint-text')!
  expect(next.getAttribute('aria-label')).toBe('下一项')
  expect(hint.getAttribute('aria-hidden')).toBe('true')
  expect([... hint.children].map(line => line.textContent)).toEqual(['右边还有！', '可左右滚动'])
  expect(hint.lastElementChild?.classList.contains('carousel-hint-detail')).toBe(true)
  expect(next.querySelector(':scope > .iconify')?.classList.contains('i-lucide:chevron-right')).toBe(true)
})

it.each(['', ' ', '\n', '  \n'])('groups explicitly wrapped images, file, folder, story and iframe cards across separator %j', (separator) => {
  const source = ['![**caption**](att://image.png)', '[](att://docs/file.txt)', '[](att://empty)', '[](content://Known)', '![player](iframe://player.bilibili.com/player.html?bvid=123)'].join(separator)
  const { root, images } = render(`<carousel>\n${source}\n</carousel>`)
  const strip = root.querySelector('.image-carousel')!
  expect(root.querySelectorAll('.carousel-shell')).toHaveLength(1)
  expect([... strip.children].filter(child => ! child.classList.contains('carousel-space')).map(child => child.classList.contains('carousel-item') ? 'image' : child.classList.contains('story-card') ? 'story' : child.classList.contains('folder-card') ? 'folder' : 'file')).toEqual(['image', 'file', 'folder', 'story', 'image'])
  expect(strip.querySelector('.carousel-caption strong')?.textContent).toBe('caption')
  expect(strip.querySelector('iframe')?.getAttribute('src')).toBe('https://player.bilibili.com/player.html?bvid=123')
  expect(images).toEqual(['/image'])
})

it.each(['', ' ', '\n', '  \n'])('keeps unwrapped mixed media in the paragraph across separator %j', (separator) => {
  const source = ['![caption](att://image.png)', '[](att://docs/file.txt)', '[](att://empty)', '[](content://Known)', '![player](iframe://player.bilibili.com/player.html?bvid=123)'].join(separator)
  const { root, images } = render(source)
  expect(root.querySelector('.carousel-shell')).toBeNull()
  expect(root.querySelector('.image-carousel')).toBeNull()
  expect(root.querySelectorAll('p > .carousel-item')).toHaveLength(2)
  expect(root.querySelectorAll('p > .link-card')).toHaveLength(3)
  expect(root.querySelector('.carousel-caption')?.textContent).toBe('caption')
  expect(root.querySelector('iframe')?.getAttribute('src')).toContain('bvid=123')
  expect(images).toEqual(['/image'])
})

it.each(['![**caption**](att://image.png)', '![**caption**](att://secret.png)', '![**caption**](att://missing.png)', '![**caption**](iframe://player.bilibili.com/player.html?bvid=123)'])('keeps the same complete image item alone, amid prose, and beside a file: %s', (image) => {
  const item = (source: string) => render(source).root.querySelector('.carousel-item')!.outerHTML
  expect(item(`before ${image} after`)).toBe(item(image))
  expect(item(`${image} [](att://docs/file.txt)`)).toBe(item(image))
  expect(item(`<carousel>\n${image}\n</carousel>`)).toBe(item(image))
  expect(render(image).root.querySelector('.carousel-shell')).toBeNull()
  const { root, md } = render(`before ${image} after`)
  expect(root.querySelector('.carousel-shell')).toBeNull()
  expect(root.querySelector('p')?.textContent).toContain('before')
  const inline = document.createElement('div')
  inline.innerHTML = md.renderInline(image, { images: [] })
  expect(inline.firstElementChild?.outerHTML).toBe(item(image))
})

it('keeps ordinary prose, formatted link labels, inline HTML and blank-line boundaries intact', () => {
  const { root } = render('before **bold** ![one](att://image.png) [](att://docs/file.txt) after *italic*\n\n[**custom** label](att://docs/file.txt)\n\n<span>![inside](att://image.png) and **text**</span>\n\n![last](att://image.png)')
  expect([... root.children].map(child => child.tagName)).toEqual(['P', 'P', 'P', 'P'])
  expect(root.children[0]?.querySelector('strong')?.textContent).toBe('bold')
  expect(root.children[0]?.querySelector('em')?.textContent).toBe('italic')
  expect(root.children[1]?.querySelector('a strong')?.textContent).toBe('custom')
  expect(root.children[2]?.querySelector('span > .carousel-item .carousel-caption')?.textContent).toBe('inside')
  expect(root.children[2]?.querySelector('span > strong')?.textContent).toBe('text')
  expect(root.querySelector('.carousel-shell')).toBeNull()
})

it.each(['[](att://docs/file.txt)', '[docs/file.txt](att://docs/file.txt)', '[](att://empty)', '[](content://Known)', '[](content://Gone)'])('uses the same card body alone or in a mixed strip: %s', (card) => {
  const single = render(card).root.querySelector('p > :is(.link-card, .content-placeholder)')!
  const mixed = render(`<carousel>\n${card} ![caption](att://image.png)\n</carousel>`).root.querySelector('.image-carousel > :is(.link-card, .content-placeholder)')!
  expect(single).not.toBeNull()
  expect(mixed.innerHTML).toBe(single.innerHTML)
})

it('keeps denied and redacted images captioned without disclosing the private URL or filename', () => {
  const denied = { ... files[2]!, id: 3, url: null }
  const redacted = { ... denied, has_redacted: true, redacted_url: '/redacted', redacted_image: { revision: 1, width: 20, height: 10, lqip: null, has_original: false } }
  for (const file of [denied, redacted]) {
    const source = '<carousel>\n![visible **caption**](att://secret.png) [](att://docs/file.txt)\n</carousel>'
    const { root, images } = render(source, [files[1]!, file])
    expect(root.querySelector('.image-carousel .carousel-caption strong')?.textContent).toBe('caption')
    expect(root.innerHTML).not.toContain('secret.png')
    expect(root.innerHTML).not.toContain('/private')
    expect(images).toEqual(file === denied ? [] : ['/redacted'])
    const placeholder = root.querySelector('.content-placeholder-denied.content-placeholder-media')
    expect(placeholder?.textContent ?? null).toBe(file === denied ? '你无权查看此处的机密附件' : null)
  }
})

it('groups explicitly wrapped denied file cards while keeping an outside ordinary link in its paragraph', () => {
  const { root } = render('<carousel>\n[custom](att://secret.png) [](att://docs/file.txt)\n</carousel>\n\n[ordinary](https://example.com)', [files[1]!, { ... files[2]!, url: null }])
  expect(root.querySelectorAll('.image-carousel > :is(.link-card, .content-placeholder)')).toHaveLength(2)
  expect(root.querySelector('.image-carousel .content-placeholder-denied.content-placeholder-inline')).not.toBeNull()
  expect(root.querySelector('p a')?.textContent).toContain('ordinary')
})

it('shows the failed placeholder for a missing attachment card instead of dropping it', () => {
  const { root } = render('[](att://docs/missing.txt)')
  const placeholder = root.querySelector('.content-placeholder-failed.content-placeholder-inline')
  expect(placeholder?.getAttribute('aria-label')).toBe('\u6E32\u67D3\u5931\u8D25\uFF1A\u9644\u4EF6\u4E0D\u5B58\u5728')
  expect(root.querySelector('a')).toBeNull()
})

it.each(['', ' ', '\n', '\n\n'])('renders explicit mixed items with only authored spacing %j', (separator) => {
  const source = `<carousel>\n${['![**caption**](att://image.png)', '[](att://docs/file.txt)', '[ordinary](https://example.com)'].join(separator)}\n</carousel>`
  const { root, images } = render(source)
  const strip = root.querySelector('.image-carousel')!
  expect(root.querySelectorAll('.carousel-shell')).toHaveLength(1)
  expect(strip.querySelector('.carousel-caption strong')?.textContent).toBe('caption')
  expect(strip.querySelector('a[href="https://example.com"]')?.textContent).toContain('ordinary')
  expect(strip.querySelectorAll(':scope > .carousel-space')).toHaveLength(separator ? 2 : 0)
  expect(strip.firstElementChild?.classList.contains('carousel-space')).toBe(false)
  expect(strip.lastElementChild?.classList.contains('carousel-space')).toBe(false)
  expect(strip.getAttribute('data-line')).toBe('0')
  expect(root.querySelector('.carousel-end-anchor')?.getAttribute('data-line')).toBe(String(source.split('\n').length))
  expect(images).toEqual(['/image'])
  expect(root.querySelector('carousel')).toBeNull()
})

it('keeps reference-style images, ordinary links and private items in an explicit carousel', () => {
  const { root, images } = render('[photo]: att://image.png\n[site]: https://example.com\n\n<carousel>\n![caption][photo] <good>[ordinary][site]</good>\n</carousel>')
  expect(root.querySelectorAll('.carousel-shell')).toHaveLength(1)
  expect(root.querySelector('.image-carousel > .private-inline a')?.getAttribute('href')).toBe('https://example.com')
  expect(images).toEqual(['/image'])
})

it.each([
  '<good>[](att://docs/file.txt)</good>',
  '<good>\n[](att://docs/file.txt)\n</good>',
])('keeps the public projection of %s as one carousel item', (private_item) => {
  const source = `<carousel>\n![public](att://image.png)\n${private_item}\n[public](https://example.com)\n</carousel>`
  const projected = redact_private_content(source)
  expect(projected).not.toContain('docs/file.txt')
  const { root, images } = render(projected)
  expect(root.querySelectorAll('.carousel-shell')).toHaveLength(1)
  expect(root.querySelectorAll('.image-carousel > .content-placeholder-denied')).toHaveLength(1)
  expect(root.querySelector('.image-carousel > a')?.getAttribute('href')).toBe('https://example.com')
  expect(root.innerHTML).not.toContain('docs/file.txt')
  expect(images).toEqual(['/image'])
})

it('renders a carousel inside a private block with the same images collection', () => {
  const { root, images } = render('<good>\n<carousel>\n![public](att://image.png)\n[](att://docs/file.txt)\n</carousel>\n</good>')
  expect(root.querySelector('.private-block .image-carousel')).not.toBeNull()
  expect(root.querySelectorAll('[data-line]')).toHaveLength(1)
  expect(images).toEqual(['/image'])
})

it('keeps a malformed container readable without exposing custom tags', () => {
  const { root } = render('<carousel title="broken>\n[kept](https://example.com)\n</carousel>')
  expect(root.textContent).toContain('kept')
  expect(root.querySelector('carousel')).toBeNull()
  expect(root.querySelector('.carousel-shell')).toBeNull()
})

it('renders an attributed carousel on one line and filters attributes through the usual sanitizer', () => {
  const { root, images } = render('<carousel id="pair" class="custom" title="A > B &amp; C" data-note="sample" data-wired="true" onclick="none()">![图](att://image.png) [](att://docs/file.txt)</carousel>')
  const shell = root.querySelector('#pair.carousel-shell.custom')!
  expect(shell.getAttribute('title')).toBe('A > B & C')
  expect(shell.getAttribute('data-note')).toBe('sample')
  expect(shell.hasAttribute('data-wired')).toBe(false)
  expect(shell.hasAttribute('onclick')).toBe(false)
  expect(shell.querySelector('.image-carousel')?.getAttribute('data-line')).toBe('0')
  expect(shell.querySelector('.file-card')).not.toBeNull()
  expect(images).toEqual(['/image'])
})

it('keeps a carousel nested within prose inside its original paragraph', () => {
  const { root } = render('起始<carousel id=inline title="行内组">**内容** [](att://docs/file.txt)</carousel>结尾')
  const paragraph = root.querySelector('p')!
  const shell = paragraph.querySelector(':scope > span#inline.carousel-shell-inline')!
  expect(shell.getAttribute('title')).toBe('行内组')
  expect(shell.querySelector(':scope > span.image-carousel strong')?.textContent).toBe('内容')
  expect(shell.querySelector('.file-card')).not.toBeNull()
  expect(paragraph.firstChild?.textContent).toBe('起始')
  expect(paragraph.lastChild?.textContent).toBe('结尾')
})

it('keeps nested inline carousels when rendering a block carousel', () => {
  const { root } = render('<carousel class=outer>\n文字 <carousel id=inner>**内层**</carousel> 文字\n</carousel>')
  const shell = root.querySelector('.outer.carousel-shell')!
  expect(shell.querySelector(':scope > .image-carousel > #inner.carousel-shell-inline strong')?.textContent).toBe('内层')
  expect(shell.querySelectorAll('.carousel-end-anchor')).toHaveLength(1)
})

it('keeps prose and formatting together while splitting neighboring media and links', () => {
  const { root } = render('<carousel>\n前文 **加粗** 和 *斜体* `code` ![caption](att://image.png)[链接](https://example.com)后文\n</carousel>')
  const strip = root.querySelector('.image-carousel')!
  const children = [... strip.children]
  expect(children.map(child => child.className)).toEqual(['carousel-content-item', 'carousel-space', 'carousel-item carousel-item-captioned', 'link-card link-chip', 'carousel-content-item'])
  expect(children[0]?.querySelector('strong')?.textContent).toBe('加粗')
  expect(children[0]?.querySelector('em')?.textContent).toBe('斜体')
  expect(children[0]?.querySelector('code')?.textContent).toBe('code')
  expect(children.at(- 1)?.textContent).toBe('后文')
})

it.each(['', ' ', '\n', '\n\n'])('preserves authored separation between text and media: %j', (separator) => {
  const { root } = render(`<carousel>\n文字${separator}![caption](att://image.png)${separator}**格式**\n</carousel>`)
  const strip = root.querySelector('.image-carousel')!
  expect(strip.querySelectorAll(':scope > .carousel-space')).toHaveLength(separator ? 2 : 0)
  expect(strip.querySelectorAll(':scope > .carousel-content-item')).toHaveLength(2)
  expect(strip.firstElementChild?.className).toBe('carousel-content-item')
  expect(strip.lastElementChild?.className).toBe('carousel-content-item')
})

it('renders lists, tables, quotes, headings and code as independent blocks without flattening their contents', () => {
  const { root } = render('<carousel>\n## Heading\n\n- one\n- **two**\n\n| Column |\n| --- |\n| Cell |\n\n> quoted *text*\n\n```ts\nconst x = "</carousel>"\n```\n</carousel>')
  const strip = root.querySelector('.image-carousel')!
  const blocks = [... strip.querySelectorAll(':scope > .carousel-content-item')]
  expect(blocks).toHaveLength(5)
  expect(blocks[0]?.querySelector('h2')?.textContent).toBe('Heading')
  expect(blocks[1]?.querySelectorAll('li')).toHaveLength(2)
  expect(blocks[1]?.querySelector('strong')?.textContent).toBe('two')
  expect(blocks[2]?.querySelector('td')?.textContent).toBe('Cell')
  expect(blocks[3]?.querySelector('blockquote em')?.textContent).toBe('text')
  expect(blocks[4]?.querySelector('pre code.language-ts')?.textContent).toBe('const x = "</carousel>"\n')
  expect(strip.querySelectorAll(':scope > .carousel-space')).toHaveLength(4)
  expect(strip.querySelectorAll('[data-line]')).toHaveLength(0)
})

it('preserves complete inline and block HTML wrappers with their nested Markdown', () => {
  const { root, images } = render('<carousel>\n<span>inline **kept** ![caption](att://image.png)</span>\n\n<div>\n\nblock **kept**\n\n![caption](att://image.png)\n\n</div>\n</carousel>')
  const strip = root.querySelector('.image-carousel')!
  expect(strip.querySelectorAll(':scope > .carousel-content-item')).toHaveLength(2)
  expect(strip.querySelector('.carousel-content-item > span strong')?.textContent).toBe('kept')
  expect(strip.querySelector('.carousel-content-item > div > p strong')?.textContent).toBe('kept')
  expect(strip.querySelectorAll('.carousel-item')).toHaveLength(2)
  expect(images).toEqual(['/image', '/image'])
  expect(strip.querySelectorAll('[data-line]')).toHaveLength(0)
})

it('supports nested carousels without adding inner source anchors or losing shared image ordering', () => {
  const { root, images } = render('<carousel>\nouter ![first](att://image.png)\n\n<carousel>\n**inner** ![second](att://secret.png)\n</carousel>\n\nlast\n</carousel>')
  const outer = root.querySelector('.image-carousel')!
  const inner = outer.querySelector('.carousel-content-item > .carousel-shell > .image-carousel')!
  expect(root.querySelectorAll('.carousel-shell')).toHaveLength(2)
  expect(inner.querySelector('strong')?.textContent).toBe('inner')
  expect(inner.hasAttribute('data-line')).toBe(false)
  expect(outer.querySelectorAll('[data-line]')).toHaveLength(0)
  expect(root.querySelectorAll('.carousel-end-anchor')).toHaveLength(1)
  expect(images).toEqual(['/image', '/private'])
})

it('keeps a private block immediately after prose and projects its public placeholder within the carousel', () => {
  const source = '<carousel>\npublic\n<good>\nsecret **formatted**\n\n![secret image](att://secret.png)\n</good>\n</carousel>'
  const authored = render(source)
  expect(authored.root.querySelector('.image-carousel .private-block strong')?.textContent).toBe('formatted')
  expect(authored.root.querySelector('.image-carousel [data-line]')).toBeNull()
  expect(authored.images).toEqual(['/private'])
  const projected = render(redact_private_content(source))
  expect(projected.root.querySelector('.image-carousel .content-placeholder-denied')).not.toBeNull()
  expect(projected.root.textContent).toContain('public')
  expect(projected.root.innerHTML).not.toContain('secret')
  expect(projected.images).toEqual([])
})

it('uses the regular sanitizer for arbitrary block content', () => {
  const { root } = render('<carousel>\n<script>alert("secret")</script>\n\n<div onclick="alert(1)">**safe**</div>\n\n<iframe src="https://evil.example/player"></iframe>\n</carousel>')
  expect(root.querySelector('.image-carousel strong')?.textContent).toBe('safe')
  expect(root.querySelector('script, iframe, [onclick]')).toBeNull()
  expect(root.textContent).not.toContain('secret')
})
