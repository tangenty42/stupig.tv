import type { ContentStoryAttachment } from '@shared/types/content'
import { readdirSync, readFileSync } from 'node:fs'
import { CONTENT_ATTACHMENT_DENIED_TEXT, CONTENT_IMAGE_DENIED_TEXT } from '@shared/content-markdown'
import { CONTENT_PRIVATE_BLOCK_PLACEHOLDER, CONTENT_PRIVATE_DENIED_TEXT, CONTENT_PRIVATE_INLINE_PLACEHOLDER } from '@shared/content-private'
import { describe, expect, it } from 'vitest'
import { content_attachment_markdown, content_folder_markdown } from '~/utils/content/attachment-drag'
import { create_story_markdown } from '~/utils/content/markdown'
import { story_compiled_icons } from '~/utils/content/markdown/compiled-icons'

function attachment(file_name: string, is_image: boolean): ContentStoryAttachment {
  return {
    file_name,
    mime_type: is_image ? 'image/png' : 'text/plain',
    file_size: 1024,
    is_image,
    version: 'v1',
    url: `/objects/${file_name}`,
    is_encrypted: false,
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

  it('carries a label written on the folder reference onto every image', () => {
    // The reference is shorthand for the per-file tags, label included:
    // `![卡片](cards)` must render exactly like the spelled-out labeled tags,
    // captions and all.
    expect(render('![卡片](cards)').html)
      .toBe(render('![卡片](cards/1.png)![卡片](cards/2.png)![卡片](cards/10.png)').html)
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

  it('stays equivalent when other content shares the paragraph', () => {
    // The expanded images are spliced in adjacent, the literal spelling has a
    // line break between tags; both must split into the same carousel plus a
    // trailing folder-card paragraph. data-line differs because the two
    // spellings occupy a different number of source lines.
    const strip_lines = (html: string) => html.replaceAll(/ data-line="\d+"/g, '')
    const shorthand = render('![](cards)\n[](cards)').html
    const literal = render('![](cards/1.png)\n![](cards/2.png)\n![](cards/10.png)\n[](cards)').html

    expect(shorthand).toContain('image-carousel')
    expect(strip_lines(shorthand)).toBe(strip_lines(literal))
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
    const { html } = render('[](solo.png)\n')

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
        { ... attachment('locked.png', true), file_name: 'locked.png.good', is_encrypted: true },
        { ... attachment('unlocked.png', true), file_name: 'unlocked.png.good', is_encrypted: true, encryption_key: 'a2V5' },
        // An encrypted image WITH a plaintext 删减版 twin: an unauthorized
        // viewer gets the twin, which is the only path that emits the closed
        // keyhole. Without this pair the 删减版 branch is never rendered, and
        // the icon it carries went unchecked for exactly that reason.
        attachment('twin.png', true),
        { ... attachment('twin.png', true), file_name: 'twin.png.good', is_encrypted: true },
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
      video_card: () => ({
        bvid: 'BV1',
        url: 'https://www.bilibili.com/video/BV1',
        title: '视频',
        cover: 'https://i0.hdslb.com/x.jpg',
        uploader: 'UP主',
        duration: 61,
        views: 100,
        likes: 10,
      }),
      folder_card_openable: () => true,
    })
    const markdown = [
      '> [!NOTE]\n> 提示\n',
      '> [!TIP]\n> tip\n',
      '> [!IMPORTANT]\n> 重要\n',
      '> [!WARNING]\n> 警告\n',
      '> [!CAUTION]\n> 注意\n',
      '[](doc.pdf) [](data.xlsx) [](archive.zip) [](song.mp3) [](clip.mp4) [](code.sql) [](notes.txt)\n',
      '[](cards)\n',
      '[](https://www.bilibili.com/video/BV1)\n',
      '[](@目标档案) [](@不存在的档案)\n',
      '[标签](https://example.com/x)\n',
      '<good>secret</good>\n',
      '<good>\nsecret\n</good>\n',
      // Denied placeholders and an encrypted-but-keyless attachment (denied card).
      `before ${CONTENT_PRIVATE_INLINE_PLACEHOLDER} after\n`,
      `${CONTENT_PRIVATE_BLOCK_PLACEHOLDER}\n`,
      '[](locked.png.good)\n',
      '![](unlocked.png.good)\n',
      // The 删减版 twin as an image (abridged brand) and as a card
      // (the substituted encrypted card).
      '![](twin.png.good)\n',
      '[](twin.png.good)\n',
    ].join('\n')

    const html = md.render(markdown, { images: [], bilibili_hrefs: [] })
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

describe('encrypted attachments', () => {
  const encrypted = {
    file_name: 'secret.png.good',
    mime_type: 'image/png',
    file_size: 1024,
    is_image: true,
    version: 'v1',
    url: '/objects/secret.png.good',
    is_encrypted: true,
  }
  const with_key = { ... encrypted, encryption_key: 'a2V5' }

  it('marks an encrypted file card for client-side decryption when the key shipped', () => {
    const { html } = render('[](secret.png.good)\n', [with_key])

    expect(html).toContain('data-encrypted')
    expect(html).toContain('i-lucide:lock-keyhole-open')
    // Amber chrome plus the 机密附件 tag mark the card as encrypted.
    expect(html).toContain('file-card-encrypted')
    expect(html).toContain('机密附件')
    // The card displays the pre-encryption name; the .good suffix only
    // survives in the ciphertext href.
    expect(html).toContain('file-card-name">secret.png<')
    expect(html).toContain('secret.png.good')
  })

  it('renders a nameless denied card when no key shipped', () => {
    const { html } = render('[](secret.png.good)\n', [encrypted])

    expect(html).toContain('encrypted-card-denied')
    expect(html).toContain('i-lucide:ban"')
    expect(html).toContain(CONTENT_ATTACHMENT_DENIED_TEXT)
    expect(html).not.toContain('secret.png.good')
  })

  it('denies even a labeled link to an encrypted file without a key', () => {
    const { html } = render('[下载](secret.png.good)\n', [encrypted])

    expect(html).toContain('encrypted-card-denied')
    expect(html).not.toContain('secret.png.good')
  })

  it('marks an encrypted image for decryption when the key shipped', () => {
    const { html } = render('![](secret.png.good)\n', [with_key])

    expect(html).toContain('data-encrypted')
    expect(html).toContain('/objects/secret.png.good')
    // The amber card announces 机密附件 with a loader until the blob lands.
    expect(html).toContain('encrypted-block-brand')
    expect(html).toContain('机密附件·解密中')
    expect(html).toContain('encrypted-image-loading')
  })

  it('keeps the frame and caption, swapping only the img for a placeholder', () => {
    const { html, images } = render('![背面的故事](secret.png.good)\n', [encrypted])

    expect(html).toContain('encrypted-image-denied')
    expect(html).toContain(CONTENT_IMAGE_DENIED_TEXT)
    expect(html).toContain('img-frame')
    // The caption survives; the ciphertext URL and file name do not.
    expect(html).toContain('背面的故事')
    expect(html).not.toContain('/objects/secret.png.good')
    expect(html).not.toContain('<img')
    // No lightbox entry for content the viewer cannot decrypt.
    expect(images).toEqual([])
  })
})

describe('abridged twin (删减版)', () => {
  const twin = {
    file_name: 'secret.png',
    mime_type: 'image/png',
    file_size: 512,
    is_image: true,
    version: 'v1',
    url: '/objects/secret.png',
    is_encrypted: false,
  }
  const encrypted = {
    file_name: 'secret.png.good',
    mime_type: 'image/png',
    file_size: 1024,
    is_image: true,
    version: 'v2',
    url: '/objects/secret.png.good',
    is_encrypted: true,
  }
  const with_key = { ... encrypted, encryption_key: 'a2V5' }

  it('renders the twin as an amber card for unauthorized viewers', () => {
    const { html } = render('[](secret.png.good)\n', [encrypted, twin])

    expect(html).toContain('file-card-encrypted')
    expect(html).toContain('机密附件·删减版')
    // The card links the plaintext twin and never mentions the ciphertext.
    expect(html).toContain('href="/objects/secret.png"')
    expect(html).not.toContain('secret.png.good')
    expect(html).not.toContain('data-encrypted')
  })

  it('renders the twin image with a 删减版 brand for unauthorized viewers', () => {
    const { html, images } = render('![](secret.png.good)\n', [encrypted, twin])

    expect(html).toContain('机密附件·删减版')
    expect(html).toContain('src="/objects/secret.png"')
    expect(html).not.toContain('encrypted-image-denied')
    expect(images).toEqual(['/objects/secret.png'])
  })

  it('gives permitted viewers a full/abridged toggle on the file card', () => {
    const { html } = render('[](secret.png.good)\n', [with_key, twin])

    expect(html).toContain('data-twin-url="/objects/secret.png"')
    expect(html).toContain('encrypted-toggle')
    expect(html).toContain('查看删减版')
  })

  it('gives permitted viewers a toggle on the image card', () => {
    const { html } = render('![](secret.png.good)\n', [with_key, twin])

    expect(html).toContain('data-twin-url="/objects/secret.png"')
    expect(html).toContain('encrypted-toggle')
    expect(html).toContain('机密附件·解密中')
  })

  it('points a labeled link at the twin for unauthorized viewers', () => {
    const { html } = render('[下载](secret.png.good)\n', [encrypted, twin])

    expect(html).toContain('href="/objects/secret.png"')
    expect(html).not.toContain('encrypted-card-denied')
    expect(html).not.toContain('data-encrypted')
  })

  it('falls back to the denied card when there is no twin', () => {
    const { html } = render('[](secret.png.good)\n', [encrypted])

    expect(html).toContain('encrypted-card-denied')
  })
})
