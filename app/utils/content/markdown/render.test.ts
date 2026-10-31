import type { ContentStoryAttachment } from '@shared/types/content'
import { readdirSync, readFileSync } from 'node:fs'
import { CONTENT_ATTACHMENT_DENIED_TEXT, CONTENT_IMAGE_DENIED_TEXT, upgrade_legacy_refs } from '@shared/content-markdown'
import { CONTENT_PRIVATE_BLOCK_PLACEHOLDER, CONTENT_PRIVATE_DENIED_TEXT, CONTENT_PRIVATE_INLINE_PLACEHOLDER } from '@shared/content-private'
import { describe, expect, it } from 'vitest'
import { attachment_for_link } from '~/utils/content/attachment'
import { content_attachment_markdown, content_folder_markdown } from '~/utils/content/attachment-drag'
import { create_story_markdown } from '~/utils/content/markdown'
import { story_compiled_icons } from '~/utils/content/markdown/compiled-icons'
import { sanitize_story_html } from '~/utils/content/markdown/sanitize'
import { render_story_cover } from '~/utils/content/story-cover'

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
  const file = { ... attachment('report.txt', false), url: '/api/content/attachments/7?version=server-version' }
  const md = create_story_markdown({ story_id: () => 1, attachments: () => [file], static_url: path => path, stories: () => [], folder_card_openable: () => false })
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
  const file = { ... attachment('Docs/É.png', true), url: '/api/content/attachments/7?version=server-version' }
  const md = create_story_markdown({ story_id: () => 1, attachments: () => [file], static_url: path => path, folders: () => [], folder_card_openable: () => false,
    stories: () => [{ id: 2, title: 'Other', labels: [], desc: null, cover: null }] as never })
  const html = md.render('![image](ATT://docs/E%CC%81.PNG?version=wrong&download=1#page2) [story](CONTENT://OTHER?view=card#top)', { images: [] })
  expect(html).toContain('/api/content/attachments/7?version=server-version&amp;download=1#page2')
  expect(html).not.toContain('version=wrong')
  expect(html).toContain('/content/2?view=card#top')
})

it('uses the shared cover renderer for story references, including dimensions and LQIP', () => {
  const image = { revision: 2, width: 120, height: 80, lqip: 'data:image/jpeg;base64,/9j/2Q==', has_original: false }
  const md = create_story_markdown({ story_id: () => 1, attachments: () => [], static_url: path => path, folder_card_openable: () => false,
    stories: () => [{ id: 2, title: 'Other', labels: [], event_precision: 'day', event_dates: [], created_at: '', updated_at: '', desc: null,
      cover: 'cover.png', cover_label: null, cover_url: '/cover', cover_version: 'v2', cover_image: image }] })
  const html = md.render('[](content://Other)', { images: [] })
  expect(html).toContain(sanitize_story_html(render_story_cover('/cover', 'cover.png', image)))
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

function render(markdown: string, list: ContentStoryAttachment[] = attachments, folder_openable = false, folders: string[] = []) {
  const md = create_story_markdown({
    story_id: () => 1,
    attachments: () => list,
    folders: () => folders,
    stories: () => [],
    static_url: path => path,
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
    const { html, images } = render('![图片](att://solo.png)\n![视频](iframe://player.bilibili.com/player.html?bvid=BV1Pvnd6JEVD)')
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

it.each(['gif', 'svg', 'avif'])('renders a loading mask without requiring an LQIP for %s images', (extension) => {
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

  it.each(['att://missing.png', 'missing.png'])('replaces only the image for %s and keeps the normal formatted caption', (destination) => {
    const result = render(`![**失效** *图片*](${destination})`)
    expect(result.html).toContain('class="image-unavailable"')
    expect(result.html).toContain('i-lucide:image-off')
    expect(result.html).toContain('data-image-error')
    expect(result.html).toContain('aria-label="附件不存在或引用无效"')
    expect(result.html).toContain('<span class="carousel-caption"><strong>失效</strong> <em>图片</em></span>')
    expect(result.html).toContain('carousel-item-captioned')
    expect(result.html).not.toContain('<img')
    expect(result.html).not.toContain('image-loading-mask')
    expect(result.html).not.toContain('long-img-cover')
    expect(result.images).toEqual([])
  })

  it.each(['', 'missing.png'])('keeps the existing caption suppression for label %s', (label) => {
    const { html } = render(`![${label}](att://missing.png)`)
    expect(html).toContain('image-unavailable')
    expect(html).not.toContain('carousel-caption')
  })

  it('keeps valid lightbox indices contiguous around an invalid gallery item', () => {
    const result = render('![first](att://cards/1.png)![**missing**](att://missing.png)![last](att://cards/2.png)')
    expect(result.images).toEqual(['/objects/cards/1.png', '/objects/cards/2.png'])
    expect(result.html.match(/data-preview-index="\d+"/g)).toEqual(['data-preview-index="0"', 'data-preview-index="1"'])
    expect(result.html).toContain('<span class="carousel-caption"><strong>missing</strong></span>')
  })

  it('provides the same placeholder for a later load failure without changing caption rendering', () => {
    const { html } = render('![**network** error](https://static.test/missing.png)')
    expect(html).toContain('class="image-unavailable" role="img" aria-label="图片加载失败"')
    expect(html).toContain('<span class="carousel-caption"><strong>network</strong> error</span>')
    expect(html).toContain('image-loading-mask')
  })
})

describe('private bucket rendering during release A', () => {
  const private_image = { ... attachment('secret.png.good', true), is_private: true, url: '/api/content/attachments/11?version=v1' }

  it('uses same-origin authorized addresses without a ciphertext decoder or static host prefix', () => {
    const md = create_story_markdown({ story_id: () => 1, attachments: () => [private_image], stories: () => [], static_url: path => `https://static.test${path}`, folder_card_openable: () => false })
    const html = md.render('![](att://secret.png.good) [](att://secret.png.good)', { images: [] })
    expect(html).toContain('src="/api/content/attachments/11?version=v1"')
    expect(html).toContain('href="/api/content/attachments/11?version=v1"')
    expect(html).toContain('data-private')
    expect(html).not.toContain('data-encrypted')
    expect(html).not.toContain('<img hidden')
    expect(html).not.toContain('https://static.test/api/')
  })

  it('shows the same-row redacted version to a denied viewer and ignores same-name siblings', () => {
    const denied = { ... private_image, url: null }
    const result = render('![](att://secret.png.good) [](att://secret.png.good)', [{ ... denied, redacted_url: '/objects/secret.png', redacted_image: { revision: 1, width: 2, height: 2, has_original: false, lqip: null } }])
    expect(result.images).toEqual(['/objects/secret.png'])
    expect(result.html).toContain('href="/objects/secret.png"')
    expect(result.html).not.toContain('/api/content/attachments/')
    const without_twin = render('![](att://secret.png.good) [](att://secret.png.good)', [denied, attachment('secret.png', true)])
    expect(without_twin.images).toEqual([])
    expect(without_twin.html).toContain(CONTENT_IMAGE_DENIED_TEXT)
    expect(without_twin.html).toContain(CONTENT_ATTACHMENT_DENIED_TEXT)
  })
})

describe('explicit reference rendering', () => {
  it.each(['![](cards)', '[](cards)', '[说明](cards/notes.txt)', '![](其他/x.png)'])('does not resolve the retired expression %s', (markdown) => {
    const old = render(markdown)
    expect(old.images).toEqual([])
    expect(old.html).not.toContain('/objects/')
    expect(render(upgrade_legacy_refs(markdown)).html).not.toBe(old.html)
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
      story_id: () => 1, attachments: () => [], static_url: path => path,
      stories: () => [{ id: 2, title: '其他档案', labels: [], event_precision: 'day', event_dates: [], created_at: '', updated_at: '', desc: null, cover: null, cover_label: null, cover_version: null, cover_url: null }],
      folder_card_openable: () => false,
    })
    expect(md.render('[](content://其他档案) [说明](content://其他档案)')).toContain('href="/content/2"')
    expect(md.render('[](@其他档案) [说明](@其他档案)')).not.toContain('href="/content/2"')
  })
})

describe('folder image expansion', () => {
  it('expands an image reference to a folder into its images', () => {
    const { html, images } = render('![](att://cards)')

    expect(image_sources(html)).toEqual([
      '/objects/cards/1.png',
      '/objects/cards/2.png',
      '/objects/cards/10.png',
    ])
    // Every expanded image reaches the lightbox, in the same order.
    expect(images).toEqual([
      '/objects/cards/1.png',
      '/objects/cards/2.png',
      '/objects/cards/10.png',
    ])
  })

  it('orders the images naturally rather than by code point', () => {
    const { images } = render('![](att://cards)')

    // String order would put 10.png before 2.png.
    expect(images).toEqual([
      '/objects/cards/1.png',
      '/objects/cards/2.png',
      '/objects/cards/10.png',
    ])
  })

  it('takes direct children only, leaving subfolders out', () => {
    const { images } = render('![](att://cards)')

    expect(images).not.toContain('/objects/cards/sub/9.png')
  })

  it('skips files that are not images', () => {
    const { images } = render('![](att://cards)')

    expect(images).not.toContain('/objects/cards/notes.txt')
  })

  it('accepts a trailing slash', () => {
    expect(image_sources(render('![](att://cards/)').html)).toEqual([
      '/objects/cards/1.png',
      '/objects/cards/2.png',
      '/objects/cards/10.png',
    ])
  })

  it('accepts a nested folder path', () => {
    expect(image_sources(render('![](att://cards/sub)').html)).toEqual(['/objects/cards/sub/9.png'])
  })

  it('labels each expanded image with its own file name', () => {
    const { html } = render('![](att://cards)')

    expect(html).toContain('alt="1.png"')
    expect(html).toContain('alt="2.png"')
    expect(html).toContain('alt="10.png"')
  })

  it('carries a label written on the folder reference onto every image', () => {
    // The reference is shorthand for the per-file tags, label included:
    // `![卡片](att://cards)` must render exactly like the spelled-out labeled tags,
    // captions and all.
    expect(render('![卡片](att://cards)').html)
      .toBe(render('![卡片](att://cards/1.png)![卡片](att://cards/2.png)![卡片](att://cards/10.png)').html)
  })

  it('leaves a plain file reference alone', () => {
    const { html, images } = render('![](att://solo.png)')

    expect(image_sources(html)).toEqual(['/objects/solo.png'])
    expect(images).toEqual(['/objects/solo.png'])
  })

  it('renders a missing attachment without falling back to the old OSS path', () => {
    // Not a folder and not a file: the existing dead-image rendering stands.
    const { html } = render('![](att://nope)')

    expect(image_sources(html)).toEqual([])
    expect(html).toContain('附件不存在或引用无效')
  })

  it('prefers a real file over a folder of the same name', () => {
    const list = [attachment('cards', true), attachment('cards/1.png', true)]

    expect(image_sources(render('![](att://cards)', list).html)).toEqual(['/objects/cards'])
  })

  it('renders a folder holding no images as nothing', () => {
    const list = [attachment('docs/a.txt', false)]

    expect(image_sources(render('![](att://docs)', list).html)).toEqual([])
  })

  it('leaves an empty folder path alone', () => {
    expect(image_sources(render('![](/)').html)).toEqual(['/'])
  })

  it('joins a folder run into a carousel like hand-written images', () => {
    const { html } = render('![](att://cards)')

    // The carousel rule sees a run of consecutive images, exactly as it would
    // for three literal ![]() tags.
    expect(html).toContain('image-carousel')
    expect(html).toContain('carousel-item')
  })

  it('matches the literal tag for a single-image folder', () => {
    const list = [attachment('lonely/a.png', true)]

    expect(render('![](att://lonely)', list).html).toBe(render('![](att://lonely/a.png)', list).html)
  })

  it('renders exactly as the literal image tags would', () => {
    const expanded = render('![](att://cards)').html
    // Adjacent with no separator: the expansion splices the tags in with
    // nothing between them, so that is the literal spelling to compare against.
    // (Space-separated tags are a text-separated run the carousel rule treats
    // differently, which is why they are not the reference here.)
    const literal = render('![](att://cards/1.png)![](att://cards/2.png)![](att://cards/10.png)').html

    // The whole point of the feature: the folder reference is shorthand for the
    // per-file tags, so the markup must not differ in any way.
    expect(expanded).toBe(literal)
  })

  it('stays equivalent when other content shares the paragraph', () => {
    // The expanded images are spliced in adjacent, the literal spelling has a
    // line break between tags; both must split into the same carousel plus a
    // trailing folder-card paragraph. data-line differs because the two
    // spellings occupy a different number of source lines.
    const strip_lines = (html: string) => html.replaceAll(/ data-line="\d+"/g, '')
    const shorthand = render('![](att://cards)\n[](att://cards)').html
    const literal = render('![](att://cards/1.png)\n![](att://cards/2.png)\n![](att://cards/10.png)\n[](att://cards)').html

    expect(shorthand).toContain('image-carousel')
    expect(strip_lines(shorthand)).toBe(strip_lines(literal))
  })

  it('expands inside an html wrapper as well', () => {
    // html_wrappers_plugin re-renders inner markdown, which must run the same
    // core rules.
    const { images } = render('<div class="wrapper">\n\n![](att://cards)\n\n</div>')

    expect(images).toEqual([
      '/objects/cards/1.png',
      '/objects/cards/2.png',
      '/objects/cards/10.png',
    ])
  })

  it('mixes with neighbouring images on the same line', () => {
    const { images } = render('![](att://solo.png) ![](att://cards)')

    expect(images).toEqual([
      '/objects/solo.png',
      '/objects/cards/1.png',
      '/objects/cards/2.png',
      '/objects/cards/10.png',
    ])
  })

  it('expands the same reference twice consistently', () => {
    const { images } = render('![](att://cards)\n\n![](att://cards)')

    expect(images).toHaveLength(6)
    expect(images.slice(0, 3)).toEqual(images.slice(3))
  })

  it('does nothing while the attachments are not loaded yet', () => {
    // SSR renders before the payload arrives; the reference must not be eaten,
    // so it falls back to the existing legacy path for an unknown attachment.
    expect(image_sources(render('![](att://cards)', []).html)).toEqual([])
    expect(render('![](att://cards)', []).html).toContain('附件不存在或引用无效')
  })
})

describe('folder link card', () => {
  it.each(['this_is_a_folder', 'parent/empty'])('renders an explicitly known empty directory %s', (path) => {
    const { html } = render(`[](att://${path})`, [], true, [path])
    expect(html).toContain('folder-card')
    expect(html).toContain(`data-folder-card="${path}"`)
    expect(html).toContain(`file-card-name">${path.split('/').at(- 1)}<`)
    expect(html).toContain('0 个文件')
    expect(html.match(/<span/g)?.length).toBe(html.match(/<\/span>/g)?.length)
  })

  it('keeps folder cards inside nested Markdown wrappers when only directory nodes exist', () => {
    const { html } = render('<div>\n\n[](att://this_is_a_folder)\n\n</div>', [], false, ['this_is_a_folder'])
    expect(html).toContain('folder-card')
    expect(html).toContain('0 个文件')
    expect(html).not.toContain('data-folder-card')
  })
  it('renders a folder card for a label-off link to a folder', () => {
    const { html } = render('[](att://cards)')

    expect(html).toContain('folder-card')
    expect(html).toContain('i-lucide:folder')
    expect(html).toContain('file-card-name">cards<')
  })

  it('shows how many files are inside, nested ones included', () => {
    const { html } = render('[](att://cards)')

    // 1.png, 2.png, 10.png, notes.txt and sub/9.png.
    expect(html).toContain('5 个文件')
  })

  it('counts files when a directory is inferred from its children', () => {
    const list = [attachment('docs/readme.md', false)]
    const { html } = render('[](att://docs)', list)

    expect(html).toContain('1 个文件')
  })

  it('does not navigate, since the click behaviour is undecided', () => {
    const { html } = render('[](att://cards)')

    // No anchor and no out icon: the card is an inert span for now.
    expect(html).not.toContain('<a')
    expect(html).not.toContain('link-card-open')
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

  it('stays inert where the host has nowhere to open the folder', () => {
    const { html } = render('[](att://cards)')

    // A focusable button that does nothing is worse than a plain card, so the
    // hook the click handler looks for is not emitted at all.
    expect(html).toContain('folder-card')
    expect(html).not.toContain('data-folder-card')
    expect(html).not.toContain('role="button"')
    expect(html).not.toContain('tabindex')
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
      .toBe(content_attachment_markdown({ file_name: 'note.txt', is_image: false, url: '' }))
  })

  it('what it copies renders the folder card back', () => {
    expect(render(content_folder_markdown('cards')).html).toContain('folder-card')
  })

  it('does not copy the expanding form, which would render the images instead', () => {
    const copied = content_folder_markdown('cards')

    // `![](att://cards)` is still supported by hand, but the menu deliberately copies
    // the link form only.
    expect(render(copied).html).not.toContain('carousel')
    expect(render(`!${copied}`).html).toContain('carousel')
  })
})

describe('private (good) elements', () => {
  it('renders a block element as a dashed lock card with markdown inside', () => {
    const { html } = render('a\n\n<good>\nsecret **bold**\n</good>\n\nb\n')

    expect(html).toContain('class="private-block"')
    expect(html).toContain('机密内容')
    expect(html).toContain('<strong>bold</strong>')
    // The card carries its source line for editor scroll sync.
    expect(html).toContain('data-line="2"')
  })

  it('renders an inline element as a lock span', () => {
    const { html } = render('before <good>secret</good> after\n')

    expect(html).toContain('class="private-inline chip-card-gap-l chip-card-gap-r"')
    expect(html).toContain('>secret</span>')
  })

  it('skips the side gaps at a line edge', () => {
    const { html } = render('before <good>secret</good>\n')

    expect(html).toContain('class="private-inline chip-card-gap-l"')
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

  it('renders a line-start element with trailing text as an inline chip', () => {
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

    expect(html).toContain('private-block-denied')
    expect(html).toContain(CONTENT_PRIVATE_DENIED_TEXT)
  })

  it('renders the redacted inline placeholder inline', () => {
    const { html } = render(`before ${CONTENT_PRIVATE_INLINE_PLACEHOLDER} after\n`)

    expect(html).toContain('private-inline-denied chip-card-gap-l chip-card-gap-r')
  })
})

describe('plain link cards', () => {
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
      // Denied placeholders and an encrypted-but-keyless attachment (denied card).
      `before ${CONTENT_PRIVATE_INLINE_PLACEHOLDER} after\n`,
      `${CONTENT_PRIVATE_BLOCK_PLACEHOLDER}\n`,
      '[](att://locked.png.good)\n',
      '![](att://unlocked.png.good)\n',
      // The 删减版 twin as an image (abridged brand) and as a card
      // (the substituted encrypted card).
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
      '../../../../server/shared/content-private.ts',
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
  const encrypted = {
    file_name: 'secret.png.good',
    mime_type: 'image/png',
    file_size: 1024,
    is_image: true,
    version: 'v1',
    url: null,
    is_private: true,
  }
  const with_key = { ... encrypted, url: '/api/content/attachments/1?version=v1' }

  it.each([
    ['same-row', '[](att://secret.png.good)'],
    ['same-row', '[secret.png.good](att://secret.png.good)'],
  ])('shares the normal two-line card structure for %s redactions: %s', (kind, markdown) => {
    const owner = { ... encrypted, id: 1, has_redacted: true,
      redacted_url: '/public-redacted', redacted_image: { revision: 1, width: 20, height: 10, has_original: false, lqip: null } }
    const normal = { ... with_key, file_size: owner.file_size }
    const public_files = [owner]
    const { html } = render(`${markdown}\n`, public_files)
    const normal_html = render(`${markdown}\n`, [normal]).html
    const content = (value: string) => /<span class="file-card-content">([\s\S]*?)<span class="link-card-open/.exec(value)?.[1]
    const expected = content(normal_html)
    expect(expected).toBeTruthy()
    expect(content(html)?.replace('机密附件·删减版', '机密附件')).toBe(expected)
    expect(/<a [^>]*class="([^"]*)"/.exec(html)?.[1]?.split(/\s+/)).toContain('file-card')
    expect(html.match(/>secret\.png</g)).toHaveLength(1)
    expect(html).not.toContain('secret.png.good')
    expect(html).not.toContain(with_key.url)
  })

  it('renders a same-row redacted version without a public sibling or private image metadata', () => {
    const owner = { ... encrypted, id: 1, has_redacted: true, is_redacted_view: true,
      redacted_url: '/api/content/attachments/1?version=v3&role=redacted',
      redacted_image: { revision: 2, width: 40, height: 20, lqip: 'data:image/jpeg;base64,/9j/2Q==', has_original: false } }
    const { html, images } = render('![visible caption](att://secret.png.good)\n', [owner])
    expect(html).toContain('机密附件·删减版')
    expect(html).toContain('visible caption')
    expect(html).toContain('width="40"')
    expect(html).toContain('height="20"')
    expect(images).toEqual([owner.redacted_url])
    expect(html).not.toContain('encrypted-image-denied')
    expect(html).not.toContain('role=original')
  })

  it('renders only the privileged same-row image without a per-image representation switch', () => {
    const owner = { ... with_key, id: 1, has_redacted: true,
      redacted_url: '/api/content/attachments/1?version=v3&role=redacted',
      redacted_image: { revision: 2, width: 40, height: 20, lqip: null, has_original: false } }
    const { html, images } = render('![](att://secret.png.good)\n', [owner])
    expect(html).toContain('机密附件·完整版')
    expect(html).not.toContain('role=redacted')
    expect(html).not.toContain('encrypted-toggle')
    expect(images).toEqual([owner.url])
  })

  it('marks an encrypted file card for authenticated resolution when access is granted', () => {
    const { html } = render('[](att://secret.png.good)\n', [with_key])

    expect(html).toContain('data-private')
    expect(html).toContain('i-lucide:lock-keyhole-open')
    // Amber chrome plus the 机密附件 tag mark the card as encrypted.
    expect(html).toContain('file-card-encrypted')
    expect(html).toContain('机密附件')
    // The card displays the pre-encryption name; the .good suffix only
    // survives in the ciphertext href.
    expect(html).toContain('file-card-name">secret.png<')
    expect(html).toContain('/api/content/attachments/1?version=v1')
  })

  it('renders a nameless denied card when no readable URL is projected', () => {
    const { html } = render('[](att://secret.png.good)\n', [encrypted])

    expect(html).toContain('encrypted-card-denied')
    expect(html).toContain('i-lucide:ban"')
    expect(html).toContain(CONTENT_ATTACHMENT_DENIED_TEXT)
    expect(html).not.toContain('secret.png.good')
  })

  it('denies even a labeled link to an encrypted file without a readable URL', () => {
    const { html } = render('[下载](att://secret.png.good)\n', [encrypted])

    expect(html).toContain('encrypted-card-denied')
    expect(html).not.toContain('secret.png.good')
  })

  it('marks an encrypted image for authenticated resolution when access is granted', () => {
    const { html } = render('![](att://secret.png.good)\n', [with_key])

    expect(html).toContain('data-private')
    expect(html).toContain('/api/content/attachments/1?version=v1')
    // The amber card announces 机密附件 while the readable image loads.
    expect(html).toContain('encrypted-block-brand')
    expect(html).toContain('机密附件·完整版')
    expect(html).not.toContain('encrypted-image-loading')
  })

  it('keeps the frame and caption, swapping only the img for a placeholder', () => {
    const { html, images } = render('![背面的故事](att://secret.png.good)\n', [encrypted])

    expect(html).toContain('encrypted-image-denied')
    expect(html).toContain(CONTENT_IMAGE_DENIED_TEXT)
    expect(html).toContain('img-frame')
    // The caption survives; the ciphertext URL and file name do not.
    expect(html).toContain('背面的故事')
    expect(html).not.toContain('/api/content/attachments/1?version=v1')
    expect(html).not.toContain('<img')
    // No lightbox entry for content the viewer cannot decrypt.
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
  const encrypted = {
    file_name: 'secret.png.good',
    mime_type: 'image/png',
    file_size: 1024,
    is_image: true,
    version: 'v2',
    url: null,
    is_private: true,
  }
  const with_key = { ... encrypted, url: '/api/content/attachments/1?version=v1' }
  const redacted = { ... encrypted, redacted_url: twin.url,
    redacted_image: { revision: 1, width: 2, height: 2, has_original: false, lqip: null } }

  it('renders the twin as an amber card for unauthorized viewers', () => {
    const { html } = render('[](att://secret.png.good)\n', [redacted, twin])

    expect(html).toContain('file-card-encrypted')
    expect(html).toContain('机密附件·删减版')
    // The card links the plaintext twin and never mentions the ciphertext.
    expect(html).toContain('href="/objects/secret.png"')
    expect(html).not.toContain('secret.png.good')
    expect(html).not.toContain('data-encrypted')
  })

  it('renders the twin image with a 删减版 brand for unauthorized viewers', () => {
    const { html, images } = render('![](att://secret.png.good)\n', [redacted, twin])

    expect(html).toContain('机密附件·删减版')
    expect(html).toContain('src="/objects/secret.png"')
    expect(html).not.toContain('encrypted-image-denied')
    expect(images).toEqual(['/objects/secret.png'])
  })

  it('keeps a permitted file card on its full representation without a toggle', () => {
    const { html } = render('[](att://secret.png.good)\n', [with_key, twin])

    expect(html).toContain(`href="${with_key.url}"`)
    expect(html).not.toContain('data-twin-url')
    expect(html).not.toContain('encrypted-toggle')
  })

  it('keeps a permitted image on its full representation without a toggle', () => {
    const { html } = render('![](att://secret.png.good)\n', [with_key, twin])

    expect(html).toContain(`src="${with_key.url}"`)
    expect(html).not.toContain('data-twin-url')
    expect(html).not.toContain('encrypted-toggle')
    expect(html).toContain('机密附件·完整版')
  })

  it('points a labeled link at the twin for unauthorized viewers', () => {
    const { html } = render('[下载](att://secret.png.good)\n', [redacted, twin])

    expect(html).toContain('href="/objects/secret.png"')
    expect(html).not.toContain('encrypted-card-denied')
    expect(html).not.toContain('data-encrypted')
  })

  it('falls back to the denied card when there is no twin', () => {
    const { html } = render('[](att://secret.png.good)\n', [encrypted, twin])

    expect(html).toContain('encrypted-card-denied')
  })
})
