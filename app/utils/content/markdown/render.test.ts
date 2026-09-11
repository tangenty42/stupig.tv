import type { ContentStoryAttachment } from '@shared/types/content'
import { describe, expect, it } from 'vitest'
import { content_attachment_markdown, content_folder_markdown } from '~/utils/content/attachment-drag'
import { create_story_markdown } from '~/utils/content/markdown'

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

function render(markdown: string, list: ContentStoryAttachment[] = attachments, folder_openable = false) {
  const md = create_story_markdown({
    story_id: () => 1,
    attachments: () => list,
    stories: () => [],
    static_url: path => path,
    video_card: () => null,
    folder_card_openable: () => folder_openable,
  })
  const environment = { images: [] as string[], bilibili_hrefs: [] as string[] }
  const html = md.render(markdown, environment)
  return { html, images: environment.images }
}

/** The srcs of every rendered image, in document order. */
function image_sources(html: string) {
  return [... html.matchAll(/<img[^>]*src="([^"]*)"/g)].map(match => match[1])
}

describe('folder image expansion', () => {
  it('expands an image reference to a folder into its images', () => {
    const { html, images } = render('![](cards)')

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
    const { images } = render('![](cards)')

    // String order would put 10.png before 2.png.
    expect(images).toEqual([
      '/objects/cards/1.png',
      '/objects/cards/2.png',
      '/objects/cards/10.png',
    ])
  })

  it('takes direct children only, leaving subfolders out', () => {
    const { images } = render('![](cards)')

    expect(images).not.toContain('/objects/cards/sub/9.png')
  })

  it('skips files that are not images', () => {
    const { images } = render('![](cards)')

    expect(images).not.toContain('/objects/cards/notes.txt')
  })

  it('accepts a trailing slash', () => {
    expect(image_sources(render('![](cards/)').html)).toEqual([
      '/objects/cards/1.png',
      '/objects/cards/2.png',
      '/objects/cards/10.png',
    ])
  })

  it('accepts a nested folder path', () => {
    expect(image_sources(render('![](cards/sub)').html)).toEqual(['/objects/cards/sub/9.png'])
  })

  it('labels each expanded image with its own file name', () => {
    const { html } = render('![](cards)')

    expect(html).toContain('alt="1.png"')
    expect(html).toContain('alt="2.png"')
    expect(html).toContain('alt="10.png"')
  })

  it('drops a label written on the folder reference', () => {
    // The reference names a gallery, not one image, so its own label is not a
    // caption for every file inside.
    const { html, images } = render('![卡片](cards)')

    expect(images).toHaveLength(3)
    expect(html).not.toContain('卡片')
  })

  it('leaves a plain file reference alone', () => {
    const { html, images } = render('![](solo.png)')

    expect(image_sources(html)).toEqual(['/objects/solo.png'])
    expect(images).toEqual(['/objects/solo.png'])
  })

  it('leaves a missing path alone', () => {
    // Not a folder and not a file: the existing dead-image rendering stands.
    const { html } = render('![](nope)')

    expect(image_sources(html)).toEqual(['/content/1/nope'])
  })

  it('prefers a real file over a folder of the same name', () => {
    const list = [attachment('cards', true), attachment('cards/1.png', true)]

    expect(image_sources(render('![](cards)', list).html)).toEqual(['/objects/cards'])
  })

  it('renders a folder holding no images as nothing', () => {
    const list = [attachment('docs/a.txt', false)]

    expect(image_sources(render('![](docs)', list).html)).toEqual([])
  })

  it('leaves an empty folder path alone', () => {
    expect(image_sources(render('![](/)').html)).toEqual(['/'])
  })

  it('joins a folder run into a carousel like hand-written images', () => {
    const { html } = render('![](cards)')

    // The carousel rule sees a run of consecutive images, exactly as it would
    // for three literal ![]() tags.
    expect(html).toContain('image-carousel')
    expect(html).toContain('carousel-item')
  })

  it('matches the literal tag for a single-image folder', () => {
    const list = [attachment('lonely/a.png', true)]

    expect(render('![](lonely)', list).html).toBe(render('![](lonely/a.png)', list).html)
  })

  it('renders exactly as the literal image tags would', () => {
    const expanded = render('![](cards)').html
    // Adjacent with no separator: the expansion splices the tags in with
    // nothing between them, so that is the literal spelling to compare against.
    // (Space-separated tags are a text-separated run the carousel rule treats
    // differently, which is why they are not the reference here.)
    const literal = render('![](cards/1.png)![](cards/2.png)![](cards/10.png)').html

    // The whole point of the feature: the folder reference is shorthand for the
    // per-file tags, so the markup must not differ in any way.
    expect(expanded).toBe(literal)
  })

  it('expands inside an html wrapper as well', () => {
    // html_wrappers_plugin re-renders inner markdown, which must run the same
    // core rules.
    const { images } = render('<div class="wrapper">\n\n![](cards)\n\n</div>')

    expect(images).toEqual([
      '/objects/cards/1.png',
      '/objects/cards/2.png',
      '/objects/cards/10.png',
    ])
  })

  it('mixes with neighbouring images on the same line', () => {
    const { images } = render('![](solo.png) ![](cards)')

    expect(images).toEqual([
      '/objects/solo.png',
      '/objects/cards/1.png',
      '/objects/cards/2.png',
      '/objects/cards/10.png',
    ])
  })

  it('expands the same reference twice consistently', () => {
    const { images } = render('![](cards)\n\n![](cards)')

    expect(images).toHaveLength(6)
    expect(images.slice(0, 3)).toEqual(images.slice(3))
  })

  it('does nothing while the attachments are not loaded yet', () => {
    // SSR renders before the payload arrives; the reference must not be eaten,
    // so it falls back to the existing legacy path for an unknown attachment.
    expect(image_sources(render('![](cards)', []).html)).toEqual(['/content/1/cards'])
  })
})

describe('folder link card', () => {
  it('renders a folder card for a label-off link to a folder', () => {
    const { html } = render('[](cards)')

    expect(html).toContain('folder-card')
    expect(html).toContain('i-lucide:folder')
    expect(html).toContain('file-card-name">cards<')
  })

  it('shows how many files are inside, nested ones included', () => {
    const { html } = render('[](cards)')

    // 1.png, 2.png, 10.png, notes.txt and sub/9.png.
    expect(html).toContain('5 个文件')
  })

  it('always reports at least one file, since a folder is only a folder because of one', () => {
    const list = [attachment('docs/readme.md', false)]
    const { html } = render('[](docs)', list)

    expect(html).toContain('1 个文件')
  })

  it('does not navigate, since the click behaviour is undecided', () => {
    const { html } = render('[](cards)')

    // No anchor and no out icon: the card is an inert span for now.
    expect(html).not.toContain('<a')
    expect(html).not.toContain('link-card-open')
  })

  it('leaves balanced markup behind', () => {
    const { html } = render('[](cards)')

    const opens = (html.match(/<span/g) ?? []).length
    const closes = (html.match(/<\/span>/g) ?? []).length
    expect(opens).toBe(closes)
  })

  it('keeps a labeled link to a folder as an ordinary link', () => {
    const { html } = render('[卡片文件夹](cards)')

    // Same rule as file and story cards: a label means the author wants a link.
    expect(html).not.toContain('folder-card')
    expect(html).toContain('<a')
  })

  it('still renders a real file as a file card', () => {
    const { html } = render('[](solo.png)')

    expect(html).toContain('file-card')
    expect(html).not.toContain('folder-card')
    expect(html).toContain('i-lucide:file-image')
  })

  it('still hides a link to a path that is neither', () => {
    expect(render('[](nope)').html.trim()).not.toContain('link-card')
  })

  it('takes the folder name, not the whole path, as the title', () => {
    const { html } = render('[](cards/sub)')

    expect(html).toContain('file-card-name">sub<')
  })
})

describe('folder card activation', () => {
  it('carries the folder path and button semantics where the host can open it', () => {
    const { html } = render('[](cards)', attachments, true)

    expect(html).toContain('data-folder-card="cards"')
    expect(html).toContain('role="button"')
    expect(html).toContain('tabindex="0"')
    expect(html).toContain('aria-label="在附件中展开：cards"')
  })

  it('stays inert where the host has nowhere to open the folder', () => {
    const { html } = render('[](cards)')

    // A focusable button that does nothing is worse than a plain card, so the
    // hook the click handler looks for is not emitted at all.
    expect(html).toContain('folder-card')
    expect(html).not.toContain('data-folder-card')
    expect(html).not.toContain('role="button"')
    expect(html).not.toContain('tabindex')
  })

  it('carries the nested path, which is what the host expands', () => {
    const { html } = render('[](cards/sub)', attachments, true)

    expect(html).toContain('data-folder-card="cards/sub"')
  })

  it('leaves the file card inert regardless, since it navigates instead', () => {
    const { html } = render('[](solo.png)', attachments, true)

    expect(html).toContain('file-card')
    expect(html).not.toContain('data-folder-card')
  })
})

describe('folder markdown shorthand', () => {
  it('copies the plain link form, with no image prefix', () => {
    expect(content_folder_markdown('cards')).toBe('[](cards)')
    expect(content_folder_markdown('cards')).not.toContain('!')
  })

  it('keeps a nested path intact', () => {
    expect(content_folder_markdown('cards/sub')).toBe('[](cards/sub)')
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

    // `![](cards)` is still supported by hand, but the menu deliberately copies
    // the link form only.
    expect(render(copied).html).not.toContain('carousel')
    expect(render(`!${copied}`).html).toContain('carousel')
  })
})
