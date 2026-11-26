import type { ContentStoryAttachment } from '@shared/types/content'
import { readdirSync, readFileSync } from 'node:fs'
import { CONTENT_ATTACHMENT_DENIED_TEXT, CONTENT_IMAGE_DENIED_TEXT } from '@shared/content-markdown'
import { CONTENT_PRIVATE_BLOCK_PLACEHOLDER, CONTENT_PRIVATE_DENIED_TEXT, CONTENT_PRIVATE_INLINE_PLACEHOLDER } from '@shared/content-private'
import { describe, expect, it } from 'vitest'
import { content_attachment_markdown, content_folder_markdown } from '~/features/content/attachments/drag'
import { attachment_for_link } from '~/features/content/markdown/preview/attachment-links'
import { create_story_markdown } from '~/features/content/markdown/render'
import { story_compiled_icons } from '~/features/content/markdown/render/compiled-icons'
import { sanitize_story_html } from '~/features/content/markdown/render/sanitize'
import { render_story_cover } from '~/features/content/story-cover'

function attachment(file_name: string, is_image: boolean): ContentStoryAttachment {
  return {
    file_name,
    mime_type: is_image ? 'image/png' : 'text/plain',
    file_size: 1024,
    is_image,
    version: 'v1',
    url: `/objects/${file_name}`,
  }
}

it.each(['#top', '?download=1#top', '?version=wrong&download=1#top'])('retains download identity for attachment links with options: %s', (suffix) => {
  const file = { ... attachment('report.txt', false), url: '/api/links/attachments/7?version=server-version' }
  const md = create_story_markdown({ story_id: () => 1, attachments: () => [file], static_url: path => path, lqip_max_bytes: 1024, stories: () => [], folder_card_openable: () => false })
  for (const label of ['', '下载']) {
    const html = sanitize_story_html(md.render(`[${label}](att://report.txt${suffix})`, { images: [] }))
    const href = html.match(/ href="([^"]*)"/)![1]!.replaceAll('&amp;', '&')
    const identity = html.match(/ data-attachment-url="([^"]*)"/)?.[1]?.replaceAll('&amp;', '&') ?? null
    expect(href).toContain('#top')
    expect(href).not.toContain('version=wrong')
    const link = { getAttribute: (name: string) => name === 'href' ? href : name === 'data-attachment-url' ? identity : null }
    expect(attachment_for_link(new Map([[file.url, file]]), link)).toBe(file)
  }
})

it('resolves normalized attachment and title references and retains link options', () => {
  const file = { ... attachment('Docs/É.png', true), url: '/api/links/attachments/7?version=server-version' }
  const md = create_story_markdown({ story_id: () => 1, attachments: () => [file], static_url: path => path, lqip_max_bytes: 1024, folders: () => [], folder_card_openable: () => false,
    stories: () => [{ id: 2, title: 'Other', labels: [], desc: null, cover: null }] as never })
  const html = md.render('![image](ATT://docs/E%CC%81.PNG?version=wrong&download=1#page2) [story](CONTENT://OTHER?view=card#top)', { images: [] })
  expect(html).toContain('<span class="long-img-cover" aria-hidden="true">点击查看完整图片</span>')
  expect(html).toContain('/api/links/attachments/7?version=server-version&amp;download=1#page2')
  expect(html).not.toContain('version=wrong')
  expect(html).toContain('/content/2?view=card#top')
})

it('uses the shared cover renderer for story references, including dimensions and LQIP', () => {
  const image = { revision: 2, width: 120, height: 80, lqip: 'data:image/jpeg;base64,/9j/2Q==', has_original: false }
  const md = create_story_markdown({ story_id: () => 1, attachments: () => [], static_url: path => path, lqip_max_bytes: 1024, folder_card_openable: () => false,
    stories: () => [{ id: 2, title: 'Other', labels: [], event_precision: 'day', event_dates: [], created_at: '', updated_at: '', desc: null,
      cover: 'cover.png', cover_label: null, cover_url: '/cover', cover_version: 'v2', cover_image: image }] })
  const html = md.render('[](content://Other)', { images: [] })
  expect(html).toContain(sanitize_story_html(render_story_cover('/cover', 'cover.png', image, 1024)))
})

/** A story holding a `cards` gallery plus a few neighbours. */
const attachments = [
  attachment('cards/1.png', true),
  attachment('cards/10.png', true),
  attachment('cards/2.png', true),
  attachment('cards/notes.txt', false),
  attachment('cards/sub/9.png', true),
  attachment('其他/x.png', true),
  attachment('solo.png', true),
]

function render(markdown: string, list: ContentStoryAttachment[] = attachments, folder_openable = false, folders: string[] = [], can_read_private = false) {
  const md = create_story_markdown({
    story_id: () => 1,
    attachments: () => list,
    folders: () => folders,
    can_read_private: () => can_read_private,
    stories: () => [],
    static_url: path => path,
    lqip_max_bytes: 1024,
    folder_card_openable: () => folder_openable,
  })
  const environment = { images: [] as string[] }
  const html = md.render(markdown, environment)
  return { html, images: environment.images }
}

/** The srcs of every rendered image, in document order. */
function image_sources(html: string) {
  return [... html.matchAll(/<img[^>]*src="([^"]*)"/g)].map(match => match[1])
}

describe('bilibili embeds', () => {
  it('preserves the shared player parameters and uses a non-clickable Markdown caption', () => {
    const { html } = render('![我的 **视频**](iframe://player.bilibili.com/player.html?isOutside=true&aid=117506496860624&bvid=BV1Pvnd6JEVD&cid=43069541932&p=1)')
    expect(html).toContain('src="https://player.bilibili.com/player.html?isOutside=true&amp;aid=117506496860624&amp;bvid=BV1Pvnd6JEVD&amp;cid=43069541932&amp;p=1"')
    expect(html).toContain('我的 <strong>视频</strong>')
    expect(html).toContain('<span class="carousel-caption">')
    expect(html).not.toContain('<a ')
  })

  it('omits an empty caption', () => {
    const { html } = render('![](iframe://player.bilibili.com/player.html?bvid=BV1Pvnd6JEVD)')
    expect(html).toContain('<iframe')
    expect(html).not.toContain('carousel-caption')
  })

  it('supports reference definitions without modifying the player query', () => {
    const { html } = render('![说明][video]\n\n[video]: iframe://player.bilibili.com/player.html?cid=12&custom=hello')
    expect(html).toContain('player.html?cid=12&amp;custom=hello')
    expect(html).toContain('<span class="carousel-caption">说明</span>')
  })

  it('shares a carousel with images without adding the iframe to the lightbox', () => {
    const { html, images } = render('<carousel>\n![图片](att://solo.png)\n![视频](iframe://player.bilibili.com/player.html?bvid=BV1Pvnd6JEVD)\n</carousel>')
    expect(html.match(/class="carousel-item carousel-item-captioned"/g)).toHaveLength(2)
    expect(html).toContain('class="image-carousel"')
    expect(html).toContain('class="img-frame iframe-frame"')
    expect(images).toEqual(['/objects/solo.png'])
  })

  it('does not embed iframe destinations in ordinary links', () => {
    expect(render('[视频](iframe://player.bilibili.com/player.html?bvid=BV1Pvnd6JEVD)').html).not.toContain('<iframe')
  })

  it('leaves normal Bilibili links as ordinary links', () => {
    const { html } = render('[视频](https://www.bilibili.com/video/BV1Pvnd6JEVD) [短链接](https://b23.tv/abc)')
    expect(html).not.toContain('<iframe')
    expect(html).toContain('https://b23.tv/abc')
  })

  it('does not load a disguised or unapproved iframe destination', () => {
    expect(render('![bad](iframe://player.bilibili.com.evil.test/player.html?x=1)').html).not.toContain('<iframe')
    expect(render('![bad](iframe://evil.test/player.html?x=1)').html).not.toContain('<iframe')
  })

  it('rejects arbitrary iframe origins and dangerous attributes', () => {
    const html = sanitize_story_html('<iframe src="https://evil.test/player.html?bvid=x"></iframe><iframe src="https://player.bilibili.com/player.html?bvid=x" srcdoc="<script>alert(1)</script>" onload="alert(1)"></iframe>')
    expect(html).not.toContain('evil.test')
    expect(html).not.toContain('srcdoc')
    expect(html).not.toContain('onload')
    expect(html).toContain('player.bilibili.com')
  })
})

describe('version-bound JPEG placeholders', () => {
  const image = { revision: 1, width: 80, height: 60, lqip: 'data:image/jpeg;base64,/9j/2Q==', has_original: true }
  it('renders a bounded placeholder and reserves the image dimensions', () => {
    const result = render('![](att://sample.png)', [{ ... attachment('sample.png', true), image }])
    expect(result.html).toContain('data-lqip')
    expect(result.html).toContain('<span class="image-lqip" aria-hidden="true"></span>')
    expect(result.html).toContain('--content-lqip:url(data:image/jpeg;base64,/9j/2Q==)')
    expect(result.html).toContain('width="80" height="60"')
    expect(result.html).toContain('--content-image-width:80px')
    expect(result.html).toContain('--content-image-ratio:1.3333333333333333')
    expect(result.html).toContain('class="image-loading-mask"')
    expect(result.html).toContain('aria-busy="true"')
  })
  it('never uses private LQIP for denied content or its public redacted substitute', () => {
    const private_file = { ... attachment('secret.png.good', true), is_private: true, url: null, image }
    expect(render('![](att://secret.png.good)', [private_file]).html).not.toContain('/9j/2Q==')
    expect(render('![](att://secret.png.good)', [private_file]).html).not.toContain('--content-image-')
    const twin = { ... attachment('secret.png', true), image: { ... image, lqip: 'data:image/jpeg;base64,/9j/AA==' } }
    const html = render('![](att://secret.png.good)', [{ ... private_file, redacted_url: twin.url, redacted_image: twin.image }]).html
    expect(html).toContain('/9j/AA==')
    expect(html).not.toContain('/9j/2Q==')
  })
})

it.each(['gif', 'svg', 'webp'])('renders a loading mask without requiring an LQIP for %s images', (extension) => {
  const name = `raw.${extension}`
  const result = render(`![](att://${name})`, [attachment(name, true)])
  expect(result.html).toContain('class="image-loading-mask"')
  expect(result.html).toContain('aria-busy="true"')
  expect(result.html).toContain('role="status"')
  expect(result.html).not.toContain('data-lqip')
  const denied = render(`![](att://${name}.good)`, [{ ... attachment(`${name}.good`, true), is_private: true, url: null }])
  expect(denied.html).not.toContain('image-loading-mask')
})

describe('unavailable image placeholders', () => {
  it.each([
    '![**caption** *kept*](TARGET)',
    '![**caption** *kept*][f]\n\n[f]: TARGET',
    '> ![**caption** *kept*](TARGET)',
    '- ![**caption** *kept*](TARGET)',
    '<div>\n![**caption** *kept*](TARGET)\n</div>',
  ])('keeps the exact carousel and caption structure around the replaced image: %s', (markdown) => {
    const normal = render(markdown.replace('TARGET', 'att://cards/1.png')).html
    const invalid = render(markdown.replace('TARGET', 'att://missing.png')).html
    for (const html of [normal, invalid]) {
      expect(html).toContain('carousel-item carousel-item-captioned')
      expect(html).toContain('<span class="carousel-caption"><strong>caption</strong> <em>kept</em></span>')
    }
    // Only the img-frame contents/state may differ; the carousel item before
    // it and the complete caption/footer after it must remain identical.
    expect(invalid.slice(0, invalid.indexOf('<span class="img-frame"')))
      .toBe(normal.slice(0, normal.indexOf('<span class="img-frame"')))
    expect(invalid.slice(invalid.indexOf('<span class="carousel-caption"')))
      .toBe(normal.slice(normal.indexOf('<span class="carousel-caption"')))
  })

  it.each(['att://missing.png'])('replaces only the image for %s and keeps the normal formatted caption', (destination) => {
    const result = render(`![**失效** *图片*](${destination})`)
    expect(result.html).toContain('image-unavailable"')
    expect(result.html).toContain('i-lucide:triangle-alert')
    expect(result.html).toContain('data-image-error')
    expect(result.html).toContain('aria-label="渲染失败：图片无效"')
    expect(result.html).toContain('<span class="carousel-caption"><strong>失效</strong> <em>图片</em></span>')
    expect(result.html).toContain('carousel-item-captioned')
    expect(result.html).not.toContain('<img')
    expect(result.html).not.toContain('image-loading-mask')
    expect(result.html).not.toContain('long-img-cover')
    expect(result.images).toEqual([])
  })

  it('omits an empty caption on a failed image', () => {
    const { html } = render('![](att://missing.png)')
    expect(html).toContain('image-unavailable')
    expect(html).not.toContain('carousel-caption')
  })

  it('preserves an explicit caption equal to the failed image path', () => {
    const { html } = render('![missing.png](att://missing.png)')
    expect(html).toContain('image-unavailable')
    expect(html).toContain('<span class="carousel-caption">missing.png</span>')
  })

  it('preserves an explicit image path as the caption and accessible label', () => {
    const { html } = render('![cards/1.png](att://cards/1.png)')
    expect(html).toContain('<span class="carousel-caption">cards/1.png</span>')
    expect(html).toContain('alt="cards/1.png"')
    expect(html).toContain('aria-label="预览：cards/1.png"')
  })

  it('keeps valid lightbox indices contiguous around an invalid gallery item', () => {
    const result = render('![first](att://cards/1.png)![**missing**](att://missing.png)![last](att://cards/2.png)')
    expect(result.images).toEqual(['/objects/cards/1.png', '/objects/cards/2.png'])
    expect(result.html.match(/data-preview-index="\d+"/g)).toEqual(['data-preview-index="0"', 'data-preview-index="1"'])
    expect(result.html).toContain('<span class="carousel-caption"><strong>missing</strong></span>')
  })

  it('provides the same placeholder for a later load failure without changing caption rendering', () => {
    const { html } = render('![**network** error](https://static.test/missing.png)')
    expect(html).toContain('<span class="image-unavailable" role="img" aria-label="图片加载失败"><span class="iconify i-lucide:image-off" aria-hidden="true"></span></span>')
    expect(html).toContain('<span class="carousel-caption"><strong>network</strong> error</span>')
    expect(html).toContain('image-loading-mask')
  })
})

describe('private bucket rendering during release A', () => {
  const private_image = { ... attachment('secret.png.good', true), is_private: true, url: '/api/links/attachments/11?version=v1' }

  it('renders the image and link directly with their same-origin authorized address', () => {
    const md = create_story_markdown({ story_id: () => 1, attachments: () => [private_image], stories: () => [], static_url: path => `https://static.test${path}`, lqip_max_bytes: 1024, folder_card_openable: () => false })
    const html = md.render('![](att://secret.png.good) [](att://secret.png.good)', { images: [] })
    expect(html).toContain('src="/api/links/attachments/11?version=v1"')
    expect(html).toContain('href="/api/links/attachments/11?version=v1"')
    expect(html.match(/\bdata-private\b/g)).toHaveLength(2)
    expect(html).not.toContain('<img hidden')
    expect(html).not.toContain('https://static.test/api/')
  })

  it('shows the same-row redacted version to a denied viewer and ignores same-name siblings', () => {
    const denied = { ... private_image, url: null }
    const result = render('![](att://secret.png.good) [](att://secret.png.good)', [{ ... denied, redacted_url: '/objects/secret.png', redacted_image: { revision: 1, width: 2, height: 2, has_original: false, lqip: null } }])
    expect(result.images).toEqual(['/objects/secret.png'])
    expect(result.html).toContain('href="/objects/secret.png"')
    expect(result.html).not.toContain('/api/links/attachments/')
    const without_twin = render('![](att://secret.png.good) [](att://secret.png.good)', [denied, attachment('secret.png', true)])
    expect(without_twin.images).toEqual([])
    expect(without_twin.html).toContain(CONTENT_IMAGE_DENIED_TEXT)
    expect(without_twin.html).toContain(CONTENT_ATTACHMENT_DENIED_TEXT)
  })
})

describe('explicit reference rendering', () => {
  it.each(['![](cards)', '[](cards)', '[说明](cards/notes.txt)', '![](其他/x.png)'])('does not resolve the retired expression %s', (markdown) => {
    expect(render(markdown).html).not.toContain('/objects/')
  })
  it('updates literal source in image alt text while preserving nested caption rendering', () => {
    const canonical = render('![alt [](att://cards/notes.txt)](att://solo.png)')
    expect(canonical.images).toEqual(['/objects/solo.png'])
    expect(canonical.html).toContain('/objects/cards/notes.txt')
  })
  it('retains labeled missing titles as unresolved destinations in the new syntax', () => {
    const { html } = render('[文字](content://不存在)')
    expect(html).toContain('href="content://%E4%B8%8D%E5%AD%98%E5%9C%A8"')
    expect(html).toContain('class="link-card-label">文字</span>')
  })
  it('resolves a Chinese content:// title to the same card and labeled link as before', () => {
    const md = create_story_markdown({
      story_id: () => 1, attachments: () => [], static_url: path => path, lqip_max_bytes: 1024,
      stories: () => [{ id: 2, title: '其他档案', labels: [], event_precision: 'day', event_dates: [], created_at: '', updated_at: '', desc: null, cover: null, cover_label: null, cover_version: null, cover_url: null }],
      folder_card_openable: () => false,
    })
    expect(md.render('[](content://其他档案) [说明](content://其他档案)')).toContain('href="/content/2"')
    expect(md.render('[](@其他档案) [说明](@其他档案)')).not.toContain('href="/content/2"')
  })
})

describe('image references to directories', () => {
  it.each(['cards', 'cards/', 'cards/sub', 'lonely', 'docs', 'empty', 'cards?download=1#part'])('renders %s as an invalid image without expanding its contents', (path) => {
    const list = [... attachments, attachment('lonely/a.png', true), attachment('docs/a.txt', false)]
    const { html, images } = render(`![**图注**](att://${path} "说明")`, list, false, ['empty'])

    expect(html).toContain('渲染失败：图片无效')
    expect(html).toContain('<span class="carousel-caption"><strong>图注</strong></span>')
    expect(html.match(/data-image-error/g)).toHaveLength(1)
    expect(image_sources(html)).toEqual([])
    expect(images).toEqual([])
    expect(html).not.toContain('carousel-shell')
    expect(html).not.toContain('folder-card')
    expect(html).not.toContain('/objects/')
  })

  it('uses the same failure presentation as any other invalid attachment image', () => {
    expect(render('![图注](att://cards)').html).toBe(render('![图注](att://missing.png)').html)
  })

  it('leaves a plain file reference alone', () => {
    const { html, images } = render('![](att://solo.png)')

    expect(image_sources(html)).toEqual(['/objects/solo.png'])
    expect(images).toEqual(['/objects/solo.png'])
  })

  it('renders a missing attachment without falling back to the old OSS path', () => {
    const { html } = render('![](att://nope)')

    expect(image_sources(html)).toEqual([])
    expect(html).toContain('渲染失败：图片无效')
  })

  it('prefers a real file over a folder of the same name', () => {
    const list = [attachment('cards', true), attachment('cards/1.png', true)]

    expect(image_sources(render('![](att://cards)', list).html)).toEqual(['/objects/cards'])
  })

  it('leaves an empty folder path alone', () => {
    expect(image_sources(render('![](/)').html)).toEqual(['/'])
  })

  it('keeps a failed directory image beside actual images and an ordinary folder card in an explicit carousel', () => {
    const { html, images } = render('<carousel>\n![旧目录](att://cards)\n![第一张](att://cards/1.png)\n[](att://cards)\n![第二张](att://cards/2.png)\n</carousel>')
    expect(html.match(/class="image-carousel"/g)).toHaveLength(1)
    expect(html.match(/data-image-error/g)).toHaveLength(1)
    expect(html).toContain('data-folder-card="cards"')
    expect(html).toContain('carousel-caption">第一张</span>')
    expect(html).toContain('carousel-caption">第二张</span>')
    expect(images).toEqual(['/objects/cards/1.png', '/objects/cards/2.png'])
    expect(image_sources(html)).toEqual(images)
  })

  it('keeps explicit image order rather than sorting or adding neighboring directory entries', () => {
    const { html, images } = render('<carousel>\n  ![](att://cards/10.png)\n  ![](att://cards/2.png)\n  ![](att://cards/1.png)\n</carousel>')
    expect(html.match(/class="image-carousel"/g)).toHaveLength(1)
    expect(images).toEqual(['/objects/cards/10.png', '/objects/cards/2.png', '/objects/cards/1.png'])
    expect(image_sources(html)).toEqual(images)
  })

  it.each([
    ['<div class="wrapper">\n\n', '\n\n</div>'],
    ['<good>\n', '\n</good>'],
    ['> ', ''],
    ['- ', ''],
    ['<carousel>', '</carousel>'],
  ])('does not expand a directory image inside %s', (before, after) => {
    const { html, images } = render(`${before}![](att://cards)${after}`, attachments, false, [], true)
    expect(html.match(/data-image-error/g)).toHaveLength(1)
    expect(images).toEqual([])
    expect(image_sources(html)).toEqual([])
  })

  it('keeps a directory image in a caption invalid without changing the enclosing image', () => {
    const { html, images } = render('![![嵌套图注](att://cards)](att://solo.png)')
    expect(html.match(/data-image-error/g)).toHaveLength(1)
    expect(html).toContain('carousel-caption">嵌套图注</span>')
    expect(images).toEqual(['/objects/solo.png'])
    expect(image_sources(html)).toEqual(images)
  })

  it('keeps the directory image invalid after its attachment catalog becomes available', () => {
    const source = '![图注](att://cards)'
    expect(render(source, []).html).toBe(render(source, attachments).html)
  })
})

describe('folder link card', () => {
  it.each(['this_is_a_folder', 'parent/empty'])('renders an explicitly known empty directory %s', (path) => {
    const { html } = render(`[](att://${path})`, [], true, [path])
    expect(html).toContain('folder-card')
    expect(html).toContain(`data-folder-card="${path}"`)
    expect(html).toContain(`file-card-name">${path.split('/').at(- 1)}<`)
    expect(html).toContain('0 项')
    expect(html.match(/<span/g)?.length).toBe(html.match(/<\/span>/g)?.length)
  })

  it('keeps folder cards inside nested Markdown wrappers when only directory nodes exist', () => {
    const { html } = render('<div>\n\n[](att://this_is_a_folder)\n\n</div>', [], false, ['this_is_a_folder'])
    expect(html).toContain('folder-card')
    expect(html).toContain('0 项')
    expect(html).toContain('data-folder-card="this_is_a_folder"')
    expect(html).toContain('role="button"')
  })
  it.each(['docs.good', 'docs.good/sub'])('shows the private label, item count and folder icon for %s', (path) => {
    const { html } = render(`[](att://${path})`, [attachment(`${path}/readme.txt`, false)], true, [path, `${path}/empty`], true)
    expect(html).toContain('folder-card file-card-private')
    expect(html).toContain(`data-folder-card="${path}"`)
    expect(html).toContain('file-card-icon iconify i-lucide:folder')
    expect(html).toMatch(/attachment-privacy-brand[^>]*>.*<span>机密文件夹<\/span><\/span><span class="file-card-body">/)
    expect(html).toContain('<span class="file-card-size">2 项</span>')
  })

  it.each(['', '机密目录说明', '**机密目录说明**', '![](att://solo.png)'])('shows the denied placeholder for a private directory link with label %j', (label) => {
    const path = 'docs.good/nested'
    const { html, images } = render(`<carousel>[${label}](att://${path}) [](att://open)</carousel>`, [attachment('solo.png', true)], true, [path, 'open'])
    expect(html).toContain('content-placeholder-denied content-placeholder-inline')
    expect(html).toContain(CONTENT_ATTACHMENT_DENIED_TEXT)
    expect(html).not.toContain(path)
    expect(html).not.toContain('机密目录说明')
    expect(html.match(/data-folder-card=/g)).toHaveLength(1)
    expect(html).toContain('data-folder-card="open"')
    expect(images).toEqual([])
  })

  it('uses the same denied placeholder for a folder inferred from a public redaction', () => {
    const path = 'docs.good'
    const file = { ... attachment(`${path}/public.txt`, false), is_redaction: true }
    const { html } = render(`[](att://${path}) [](att://${file.file_name})`, [file])
    expect(html).toContain(CONTENT_ATTACHMENT_DENIED_TEXT)
    expect(html).not.toContain('folder-card')
    expect(html).toContain('file-card-redacted')
    expect(html).toContain(`href="${file.url}"`)
  })

  it('renders a folder card for a label-off link to a folder', () => {
    const { html } = render('[](att://cards)')

    expect(html).toContain('folder-card')
    expect(html).toContain('i-lucide:folder')
    expect(html).toContain('file-card-name">cards<')
    expect(html).toContain('link-card-open iconify i-lucide:external-link')
  })

  it('shows the total of immediate files and subfolders, including empty subfolders', () => {
    const list = [... attachments, attachment('cards/sub/nested/1.png', true), attachment('cards/sub/2.png', true)]
    const { html } = render('[](att://cards)', list, true, ['cards', 'cards/sub', 'cards/sub/nested', 'cards/empty'])
    expect(html).toContain('<span class="file-card-size">6 项</span>')
  })

  it('counts files when a directory is inferred from its children', () => {
    const list = [attachment('docs/readme.md', false)]
    const { html } = render('[](att://docs)', list)

    expect(html).toContain('1 项')
  })

  it('renders folder references as interactive cards even without an openable host', () => {
    const { html } = render('[](att://cards)')

    expect(html).not.toContain('<a')
    expect(html).toContain('data-folder-card="cards"')
    expect(html).toContain('role="button"')
    expect(html).toContain('tabindex="0"')
  })

  it('leaves balanced markup behind', () => {
    const { html } = render('[](att://cards)')

    const opens = (html.match(/<span/g) ?? []).length
    const closes = (html.match(/<\/span>/g) ?? []).length
    expect(opens).toBe(closes)
  })

  it('keeps a labeled link to a folder as an ordinary link', () => {
    const { html } = render('[卡片文件夹](att://cards)')

    // Same rule as file and story cards: a label means the author wants a link.
    expect(html).not.toContain('folder-card')
    expect(html).toContain('<a')
  })

  it('still renders a real file as a file card', () => {
    const { html } = render('[](att://solo.png)')

    expect(html).toContain('file-card')
    expect(html).not.toContain('folder-card')
    expect(html).toContain('i-lucide:file-image')
  })

  it('still hides a link to a path that is neither', () => {
    expect(render('[](att://nope)').html.trim()).not.toContain('link-card')
  })

  it('takes the folder name, not the whole path, as the title', () => {
    const { html } = render('[](att://cards/sub)')

    expect(html).toContain('file-card-name">sub<')
  })
})

describe('folder card activation', () => {
  it('carries the folder path and button semantics where the host can open it', () => {
    const { html } = render('[](att://cards)', attachments, true)

    expect(html).toContain('data-folder-card="cards"')
    expect(html).toContain('role="button"')
    expect(html).toContain('tabindex="0"')
    expect(html).toContain('aria-label="在附件中展开：cards"')
  })

  it('keeps folder-card semantics when the host cannot open the folder', () => {
    const { html } = render('[](att://cards)')

    expect(html).toContain('data-folder-card="cards"')
    expect(html).toContain('role="button"')
    expect(html).toContain('tabindex="0"')
  })

  it('carries the nested path, which is what the host expands', () => {
    const { html } = render('[](att://cards/sub)', attachments, true)

    expect(html).toContain('data-folder-card="cards/sub"')
  })

  it('leaves the file card inert regardless, since it navigates instead', () => {
    const { html } = render('[](att://solo.png)', attachments, true)

    expect(html).toContain('file-card')
    expect(html).not.toContain('data-folder-card')
  })
})

describe('folder markdown shorthand', () => {
  it('copies the plain link form, with no image prefix', () => {
    expect(content_folder_markdown('cards')).toBe('[](att://cards)')
    expect(content_folder_markdown('cards')).not.toContain('!')
  })

  it('keeps a nested path intact', () => {
    expect(content_folder_markdown('cards/sub')).toBe('[](att://cards/sub)')
  })

  it('is the same shape a non-image file link uses', () => {
    expect(content_folder_markdown('note.txt'))
      .toBe(content_attachment_markdown({ file_name: 'note.txt', is_image: false }))
  })

  it('what it copies renders the folder card back', () => {
    expect(render(content_folder_markdown('cards')).html).toContain('folder-card')
  })

  it('copies a valid folder card while an image-prefixed folder reference is invalid', () => {
    const copied = content_folder_markdown('cards')

    expect(render(copied).html).not.toContain('img-frame')
    const invalid = render(`!${copied}`)
    expect(invalid.html).toContain('渲染失败：图片无效')
    expect(invalid.html).not.toContain('carousel-shell')
    expect(invalid.images).toEqual([])
  })
})

describe('private (good) elements', () => {
  it('renders a block element with the shared privacy label above its Markdown', () => {
    const { html } = render('a\n\n<good>\nsecret **bold**\n</good>\n\nb\n')

    expect(html).toContain('class="private-block"')
    expect(html).toMatch(/class="attachment-privacy-brand"><span class="iconify i-lucide:lock" aria-hidden="true"><\/span><span>机密内容<\/span><\/span><div class="private-content-body"><p[^>]*>secret <strong>bold<\/strong><\/p>/)
    // The card carries its source line for editor scroll sync.
    expect(html).toContain('data-line="2"')
  })

  it('stacks the shared privacy label and inline Markdown inside the paragraph', () => {
    const { html } = render('before <good>**secret**</good> after\n')

    expect(html).toContain('before <span class="private-inline">')
    expect(html).toMatch(/class="attachment-privacy-brand">.*<span>机密内容<\/span><\/span><span class="private-content-body"><strong>secret<\/strong><\/span><\/span> after/)
  })

  it('renders a whole-line single-line element as a block', () => {
    const { html } = render('a\n\n<good>secret</good>\n\nb\n')

    expect(html).toContain('class="private-block"')
  })

  it('keeps text trailing the close tag out of the block card', () => {
    const { html } = render('<good>\nsecret\n</good> tail\n')

    expect(html).toContain('class="private-block"')
    expect(html).toContain('secret')
    // The trailing text renders as its own paragraph after the card.
    expect(html).toMatch(/<\/div>\s*<p[^>]*>tail<\/p>/)
  })

  it('renders a line-start element with trailing text as an inline card', () => {
    const { html } = render('<good>secret</good> tail\n')

    expect(html).toContain('private-inline')
    expect(html).not.toContain('private-block')
    // The trailing text stays ordinary inline content.
    expect(html).toContain('</span> tail')
  })

  it('leaves plain HTML untouched', () => {
    const { html } = render('a\n\n<div>\nx\n</div>\n')

    expect(html).not.toContain('private-block')
  })

  it('does not claim an unclosed tag', () => {
    const { html } = render('a\n\n<good>\nx\n')

    expect(html).not.toContain('private-block')
  })
})

describe('private placeholders', () => {
  it('renders the redacted block placeholder as the denied card', () => {
    const { html } = render(`a\n\n${CONTENT_PRIVATE_BLOCK_PLACEHOLDER}\n\nb\n`)

    expect(html).toContain('content-placeholder-denied content-placeholder-block')
    expect(html).toContain(CONTENT_PRIVATE_DENIED_TEXT)
  })

  it('renders the redacted inline placeholder inline', () => {
    const { html } = render(`before ${CONTENT_PRIVATE_INLINE_PLACEHOLDER} after\n`)

    expect(html).toContain(`before ${CONTENT_PRIVATE_INLINE_PLACEHOLDER} after`)
  })
})

it.each(['`code`', '<code>code</code>'])('keeps source spacing around inline code written as %s', (code) => {
  const { html } = render(`中文${code}中文 / 中文 ${code} 中文`)

  expect(html).toContain('中文<code>code</code>中文 / 中文 <code>code</code> 中文')
})

it('renders a soft line break as a space and preserves an explicit hard break', () => {
  const { html } = render('前文\n`code`  \n后文')

  expect(html).toMatch(/前文 <code>code<\/code><br\s*\/?>\n后文/)
})

describe('plain link cards', () => {
  it.each(['cards/sub', 'cards/notes.txt'])('preserves an explicit attachment path as link text: %s', (path) => {
    const { html } = render(`[${path}](att://${path})`)

    expect(html).toContain('link-chip')
    expect(html).toContain(`<span class="link-card-label">${path}</span>`)
    expect(html).not.toContain('file-card')
  })

  it('renders a chain icon on the left of the label', () => {
    const { html } = render('[标签](https://example.com/x)\n')

    expect(html).toContain('link-card-icon iconify i-lucide:link')
    expect(html).toContain('link-card-label')
    // link-chip marks the wrappable inline variant.
    expect(html).toContain('link-chip')
  })

  it('keeps file cards free of the chain icon (they have their own leading icon)', () => {
    const { html } = render('[](att://solo.png)\n')

    expect(html).toContain('file-card-icon')
    expect(html).not.toContain('link-card-icon')
  })
})

describe('compiled icons', () => {
  // Renders one of everything (alerts, file/folder/video/story/plain-link
  // cards, private chrome) and asserts every emitted icon is registered for
  // bundling; a renderer icon missing from story_compiled_icons ships blank.
  it('covers every icon the renderer emits', () => {
    const md = create_story_markdown({
      story_id: () => 1,
      attachments: () => [
        attachment('cards/1.png', true),
        attachment('doc.pdf', false),
        attachment('data.xlsx', false),
        attachment('archive.zip', false),
        attachment('song.mp3', false),
        attachment('clip.mp4', false),
        attachment('code.sql', false),
        attachment('notes.txt', false),
        { ... attachment('locked.png', true), file_name: 'locked.png.good', is_private: true, url: null },
        { ... attachment('unlocked.png', true), file_name: 'unlocked.png.good', is_private: true },
        // A same-row redacted version exercises the restricted-image brand.
        attachment('twin.png', true),
        { ... attachment('twin.png', true), file_name: 'twin.png.good', is_private: true, url: null,
          redacted_url: '/objects/twin.png', redacted_image: { revision: 1, width: 2, height: 2, has_original: false, lqip: null } },
      ],
      stories: () => [{
        id: 9,
        title: '目标档案',
        labels: [],
        event_precision: 'day',
        event_dates: [],
        created_at: '',
        updated_at: '',
        desc: '描述',
        cover: null,
        cover_label: null,
        cover_version: null,
        cover_url: null,
      }],
      static_url: path => path,
      lqip_max_bytes: 1024,
      folder_card_openable: () => true,
    })
    const markdown = [
      '> [!NOTE]\n> 提示\n',
      '> [!TIP]\n> tip\n',
      '> [!IMPORTANT]\n> 重要\n',
      '> [!WARNING]\n> 警告\n',
      '> [!CAUTION]\n> 注意\n',
      '[](att://doc.pdf) [](att://data.xlsx) [](att://archive.zip) [](att://song.mp3) [](att://clip.mp4) [](att://code.sql) [](att://notes.txt)\n',
      '[](att://cards)\n',
      '[](https://www.bilibili.com/video/BV1)\n',
      '[](content://目标档案) [](content://不存在的档案)\n',
      '[标签](https://example.com/x)\n',
      '<good>secret</good>\n',
      '<good>\nsecret\n</good>\n',
      // Denied placeholders and a private attachment without a readable URL.
      `before ${CONTENT_PRIVATE_INLINE_PLACEHOLDER} after\n`,
      `${CONTENT_PRIVATE_BLOCK_PLACEHOLDER}\n`,
      '[](att://locked.png.good)\n',
      '![](att://unlocked.png.good)\n',
      // The 删减版 as both an image and a file card.
      '![](att://twin.png.good)\n',
      '[](att://twin.png.good)\n',
    ].join('\n')

    const html = md.render(markdown, { images: [] })
    // Rendered classes are the `i-lucide:*` form; the bundle list uses names.
    const used = new Set([... html.matchAll(/i-lucide:[a-z0-9-]+/g)].map(match => match[0].slice(2)))

    expect(used.size).toBeGreaterThan(10)
    for (const icon of used) {
      expect(story_compiled_icons, `${icon} is not registered`).toContain(icon)
    }
  })

  /**
   * The runtime check above can only see the branches its fixtures reach, which
   * is how an unregistered icon shipped: the 删减版 path simply was not in the
   * fixture set. This scans the renderer sources instead, so a newly emitted
   * icon is caught no matter which branch produces it.
   */
  it('registers every icon literal in the renderer sources', () => {
    const emitter_files = [
      ... readdirSync(new URL('.', import.meta.url)).filter(name => name.endsWith('.ts') && ! name.endsWith('.test.ts') && name !== 'compiled-icons.ts'),
      '../../../../../server/shared/content-private.ts',
      '../../../../../server/shared/content-placeholder.ts',
      '../../image-frame.ts',
      '../../privacy-marker.ts',
    ]
    const registered = new Set(story_compiled_icons.map(icon => icon.replace(/^lucide:/, '')))
    const found = new Map<string, string>()
    for (const file of emitter_files) {
      const url = new URL(file.startsWith('..') ? file : `./${file}`, import.meta.url)
      for (const match of readFileSync(url, 'utf8').matchAll(/lucide:([a-z0-9-]+)/g))
        found.set(match[1]!, file)
    }
    expect(found.size).toBeGreaterThan(10)
    for (const [icon, file] of found) {
      expect(registered, `${icon} (${file}) is not in story_compiled_icons`).toContain(icon)
    }
  })
})

describe('private attachment projection', () => {
  const private_attachment = {
    file_name: 'secret.png.good',
    mime_type: 'image/png',
    file_size: 1024,
    is_image: true,
    version: 'v1',
    url: null,
    is_private: true,
  }
  const readable_attachment = { ... private_attachment, url: '/api/links/attachments/1?version=v1' }

  it('shares the normal two-line card structure for same-row redactions', () => {
    const owner = { ... private_attachment, id: 1, has_redacted: true,
      redacted_url: '/public-redacted', redacted_image: { revision: 1, width: 20, height: 10, has_original: false, lqip: null } }
    const normal = { ... owner, url: readable_attachment.url }
    const public_files = [owner]
    const markdown = '[](att://secret.png.good)'
    const { html } = render(markdown, public_files)
    const normal_html = render(markdown, [normal]).html
    const content = (value: string) => /<span class="file-card-content">([\s\S]*?)<span class="link-card-open/.exec(value)?.[1]
    const expected = content(normal_html)
    expect(expected).toBeTruthy()
    expect(normal_html).toMatch(/attachment-privacy-brand[^>]*>.*<span>机密附件<\/span><\/span><span class="file-card-body">/)
    expect(html).toMatch(/attachment-privacy-brand-redacted[^>]*>.*<span>机密附件删减版<\/span><\/span><span class="file-card-body">/)
    expect(content(html)).toBe(expected)
    expect(/<a [^>]*class="([^"]*)"/.exec(html)?.[1]?.split(/\s+/)).toContain('file-card')
    expect(html.match(/>secret\.png</g)).toHaveLength(1)
    expect(html).not.toContain('secret.png.good')
    expect(html).not.toContain(readable_attachment.url)
  })

  it('preserves the explicit full path as link text when opening the redaction', () => {
    const owner = { ... private_attachment, redacted_url: '/public-redacted' }
    const { html } = render('[secret.png.good](att://secret.png.good)', [owner])

    expect(html).toContain('link-chip')
    expect(html).toContain('href="/public-redacted"')
    expect(html).toContain('<span class="link-card-label">secret.png.good</span>')
    expect(html).not.toContain(readable_attachment.url)
  })

  it('renders a same-row redacted version without a public sibling or private image metadata', () => {
    const owner = { ... private_attachment, id: 1, has_redacted: true, is_redacted_view: true,
      redacted_url: '/api/links/attachments/1?version=v3&role=redacted',
      redacted_image: { revision: 2, width: 40, height: 20, lqip: 'data:image/jpeg;base64,/9j/2Q==', has_original: false } }
    const { html, images } = render('![visible caption](att://secret.png.good)\n', [owner])
    expect(html).toContain('机密附件删减版')
    expect(html).toContain('visible caption')
    expect(html).toContain('width="40"')
    expect(html).toContain('height="20"')
    expect(images).toEqual([owner.redacted_url])
    expect(html).not.toContain('content-placeholder-denied content-placeholder-media')
    expect(html).not.toContain('role=original')
  })

  it('renders only the privileged same-row image without a per-image representation switch', () => {
    const owner = { ... readable_attachment, id: 1, has_redacted: true,
      redacted_url: '/api/links/attachments/1?version=v3&role=redacted',
      redacted_image: { revision: 2, width: 40, height: 20, lqip: null, has_original: false } }
    const { html, images } = render('![](att://secret.png.good)\n', [owner])
    expect(html).toContain('机密附件')
    expect(html).not.toContain('role=redacted')
    expect(html).not.toContain('data-twin-url')
    expect(images).toEqual([owner.url])
  })

  it('marks a private file card for authenticated resolution when access is granted', () => {
    const { html } = render('[](att://secret.png.good)\n', [readable_attachment])

    expect(html).toContain('data-private')
    expect(html).toContain('file-card-icon iconify i-lucide:file-image')
    // Amber chrome plus the 机密附件 tag mark the card as private.
    expect(html).toContain('file-card-private')
    expect(html).not.toContain('file-card-redacted')
    expect(html).toContain('<span>机密附件</span></span><span class="file-card-body">')
    expect(html).toContain('<span class="file-card-size">1 KB</span>')
    // The card displays the file name without the private marker.
    expect(html).toContain('file-card-name">secret.png<')
    expect(html).toContain('/api/links/attachments/1?version=v1')
  })

  it('renders a nameless denied card when no readable URL is projected', () => {
    const { html } = render('[](att://secret.png.good)\n', [private_attachment])

    expect(html).toContain('content-placeholder-denied content-placeholder-inline')
    expect(html).toContain('i-lucide:ban"')
    expect(html).toContain(CONTENT_ATTACHMENT_DENIED_TEXT)
    expect(html).not.toContain('secret.png.good')
  })

  it('denies even a labeled link to a private file without a readable URL', () => {
    const { html } = render('[下载](att://secret.png.good)\n', [private_attachment])

    expect(html).toContain('content-placeholder-denied content-placeholder-inline')
    expect(html).not.toContain('secret.png.good')
  })

  it('marks a private image for authenticated resolution when access is granted', () => {
    const { html } = render('![](att://secret.png.good)\n', [readable_attachment])

    expect(html).toContain('data-private')
    expect(html).toContain('/api/links/attachments/1?version=v1')
    // The amber card announces 机密附件 while the readable image loads.
    expect(html).toContain('private-image-block-brand')
    expect(html).toContain('机密附件')
    expect(html).toContain('image-loading-mask')
  })

  it('keeps the frame and caption, swapping only the img for a placeholder', () => {
    const { html, images } = render('![背面的故事](att://secret.png.good)\n', [private_attachment])

    expect(html).toContain('content-placeholder-denied content-placeholder-media')
    expect(html).toContain(CONTENT_IMAGE_DENIED_TEXT)
    expect(html).toContain('img-frame')
    // The caption survives; the private URL and file name do not.
    expect(html).toContain('背面的故事')
    expect(html).not.toContain('/api/links/attachments/1?version=v1')
    expect(html).not.toContain('<img')
    // No lightbox entry for content the viewer cannot read.
    expect(images).toEqual([])
  })
})

describe('same-row redacted version (删减版)', () => {
  const twin = {
    file_name: 'secret.png',
    mime_type: 'image/png',
    file_size: 512,
    is_image: true,
    version: 'v1',
    url: '/objects/secret.png',
  }
  const private_attachment = {
    file_name: 'secret.png.good',
    mime_type: 'image/png',
    file_size: 1024,
    is_image: true,
    version: 'v2',
    url: null,
    is_private: true,
  }
  const readable_attachment = { ... private_attachment, url: '/api/links/attachments/1?version=v1' }
  const redacted = { ... private_attachment, redacted_url: twin.url,
    redacted_image: { revision: 1, width: 2, height: 2, has_original: false, lqip: null } }

  it('renders the twin with its file type icon in a blue card for unauthorized viewers', () => {
    const { html } = render('[](att://secret.png.good)\n', [redacted, twin])

    expect(html).toContain('file-card-private file-card-redacted')
    expect(html).toContain('file-card-icon iconify i-lucide:file-image')
    expect(html).toContain('<span>机密附件删减版</span></span><span class="file-card-body">')
    expect(html).toContain('<span class="file-card-size">1 KB</span>')
    // The public card links to the redaction and omits the private file name.
    expect(html).toContain('href="/objects/secret.png"')
    expect(html).not.toContain('secret.png.good')
    expect(html).not.toContain('data-private')
  })

  it('renders the twin image with a 删减版 brand for unauthorized viewers', () => {
    const { html, images } = render('![](att://secret.png.good)\n', [redacted, twin])

    expect(html).toContain('机密附件删减版')
    expect(html).toContain('private-image-block-brand private-image-block-brand-redacted')
    expect(html).toContain('i-lucide:lock-open')
    expect(html).toContain('src="/objects/secret.png"')
    expect(html).not.toContain('content-placeholder-denied content-placeholder-media')
    expect(images).toEqual(['/objects/secret.png'])
  })

  it('keeps a permitted file card on its full representation without a toggle', () => {
    const { html } = render('[](att://secret.png.good)\n', [readable_attachment, twin])

    expect(html).toContain(`href="${readable_attachment.url}"`)
    expect(html).not.toContain('data-twin-url')
    expect(html).not.toContain(twin.url)
  })

  it('keeps a permitted image on its full representation without a toggle', () => {
    const { html } = render('![](att://secret.png.good)\n', [readable_attachment, twin])

    expect(html).toContain(`src="${readable_attachment.url}"`)
    expect(html).not.toContain('data-twin-url')
    expect(html).not.toContain(twin.url)
    expect(html).toContain('机密附件')
  })

  it('keeps labeled links neutral while resolving the readable version', () => {
    const link = '[**下载**](att://secret.png.good)\n'
    const public_link = render('[**下载**](att://secret.png)\n', [twin]).html
    for (const [file, href] of [[readable_attachment, readable_attachment.url], [redacted, twin.url]] as const) {
      const { html } = render(link, [file, twin])
      const classes = (value: string) => /<a [^>]*class="([^"]*)"/.exec(value)?.[1]
      expect(html).toContain(`href="${href}"`)
      expect(html).toContain('<strong>下载</strong>')
      expect(classes(html)).toBe(classes(public_link))
      expect(html).not.toContain('file-card-private')
    }
  })

  it('uses the same redaction heading for directly referenced file and image cards', () => {
    const attachments = [{ ... twin, is_redaction: true }]
    const { html } = render('[](att://secret.png)\n', attachments)
    expect(html).toContain('file-card-private file-card-redacted')
    expect(html).toContain('file-card-icon iconify i-lucide:file-image')
    expect(html).toContain('机密附件删减版')
    expect(html).toContain(`href="${twin.url}"`)
    const image = render('![](att://secret.png)\n', attachments)
    expect(image.html).toContain('private-image-block-brand-text">机密附件删减版</span>')
    expect(image.images).toEqual([twin.url])
  })

  it('falls back to the denied card when there is no twin', () => {
    const { html } = render('[](att://secret.png.good)\n', [private_attachment, twin])

    expect(html).toContain('content-placeholder-denied content-placeholder-inline')
  })
})
