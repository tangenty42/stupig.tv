import type { ContentStoryAttachment } from '@shared/types/content'
import { describe, expect, it } from 'vitest'
import { content_attachment_drag_type, content_attachment_markdown, content_folder_drag_type, content_folder_markdown, get_content_attachment_drag_data, get_content_folder_drag_data, set_content_attachment_drag_data, set_content_folder_drag_data } from '~/utils/content/attachment-drag'

/** Minimal DataTransfer stand-in; the module only reads/writes these members. */
function fake_data_transfer() {
  const store = new Map<string, string>()
  return {
    effectAllowed: 'uninitialized',
    dropEffect: 'none',
    types: [] as string[],
    setData(type: string, value: string) {
      store.set(type, value)
      if (! this.types.includes(type)) {
        this.types.push(type)
      }
    },
    getData(type: string) {
      return store.get(type) ?? ''
    },
  }
}

function attachment(overrides: Partial<ContentStoryAttachment> = {}): ContentStoryAttachment {
  return {
    file_name: 'solo.png',
    mime_type: 'image/png',
    file_size: 1024,
    is_image: true,
    version: 'v1',
    url: '/objects/solo.png',
    ... overrides,
  }
}

function start_attachment_drag(data: Parameters<typeof set_content_attachment_drag_data>[1]) {
  const transfer = fake_data_transfer()
  set_content_attachment_drag_data({ dataTransfer: transfer } as unknown as DragEvent, data)
  return transfer
}

function start_folder_drag(folder: string, file_names?: string[]) {
  const transfer = fake_data_transfer()
  set_content_folder_drag_data({ dataTransfer: transfer } as unknown as DragEvent, folder, file_names)
  return transfer
}

describe('drag payload permissions', () => {
  // Both payloads can be dropped on either kind of target: the markdown editor
  // asks for 'copy' (it inserts a reference) and the folder rows ask for 'move'
  // (they relocate files). A payload whose effectAllowed omits either one gets
  // its drop cancelled by the browser — a "not-allowed" cursor and no drop event
  // at all. That is silent and easy to reintroduce: it has happened to both
  // payloads, the attachment one when it was plain 'copy'.
  const payloads = [
    ['attachment', () => start_attachment_drag({ file_name: 'a.png', is_image: true, url: '/a.png' })],
    ['folder', () => start_folder_drag('cards')],
  ] as const

  it.each(payloads)('lets a %s drag be inserted into the editor and moved onto a row', (_name, start) => {
    // effectAllowed is camelCase; compare case-insensitively so this asserts the
    // permitted effects rather than the spelling.
    expect(start().effectAllowed.toLowerCase()).toBe('copymove')
  })

  it.each(payloads.flatMap(([name, start]) => (['copy', 'move'] as const).map(effect => [`${name} → ${effect}`, start, effect] as const)))(
    'permits %s',
    (_case, start, effect) => {
      expect(start().effectAllowed.toLowerCase()).toContain(effect)
    },
  )

  it('leaves the effect unset when there is no data transfer', () => {
    expect(() => set_content_folder_drag_data({ dataTransfer: null } as unknown as DragEvent, 'cards')).not.toThrow()
    expect(() => set_content_attachment_drag_data({ dataTransfer: null } as unknown as DragEvent, { file_name: 'a.png', is_image: true, url: '/a.png' })).not.toThrow()
  })
})

describe('folder drag payload', () => {
  it('round-trips the folder path', () => {
    const transfer = start_folder_drag('cards/sub')

    expect(transfer.getData(content_folder_drag_type)).toBe(JSON.stringify({ folder: 'cards/sub', file_names: undefined }))
    expect(get_content_folder_drag_data(transfer as unknown as DataTransfer)).toEqual({
      folder: 'cards/sub',
      file_names: undefined,
    })
  })

  it('carries the dragged file names when a multi-selection moves', () => {
    const transfer = start_folder_drag('cards', ['other/a.png', 'other/b.png'])

    expect(get_content_folder_drag_data(transfer as unknown as DataTransfer)?.file_names)
      .toEqual(['other/a.png', 'other/b.png'])
  })

  it('omits an empty file-name list rather than sending an empty array', () => {
    expect(get_content_folder_drag_data(start_folder_drag('cards', []) as unknown as DataTransfer))
      .toEqual({ folder: 'cards', file_names: undefined })
  })

  it('accepts the legacy payload that was the raw folder path', () => {
    const transfer = fake_data_transfer()
    transfer.setData(content_folder_drag_type, 'cards')

    expect(get_content_folder_drag_data(transfer as unknown as DataTransfer)).toEqual({ folder: 'cards', file_names: undefined })
  })

  it('rejects a payload that is not an object or path', () => {
    const transfer = fake_data_transfer()
    transfer.setData(content_folder_drag_type, '{"folder":42}')

    expect(get_content_folder_drag_data(transfer as unknown as DataTransfer)).toBeNull()
  })

  it('returns null when nothing of its type was set', () => {
    expect(get_content_folder_drag_data(fake_data_transfer() as unknown as DataTransfer)).toBeNull()
    expect(get_content_folder_drag_data(null)).toBeNull()
  })
})

describe('attachment drag payload', () => {
  it('round-trips the file identity and its image flag', () => {
    const file = attachment({ file_name: 'note.txt', is_image: false })

    expect(get_content_attachment_drag_data(start_attachment_drag(file) as unknown as DataTransfer))
      .toEqual({ file_name: 'note.txt', is_image: false, url: '/objects/solo.png', file_names: undefined })
  })

  it('carries a multi-selection', () => {
    const transfer = start_attachment_drag({ file_name: 'a.png', is_image: true, url: '/a.png', file_names: ['a.png', 'b.png'] })

    expect(get_content_attachment_drag_data(transfer as unknown as DataTransfer)?.file_names).toEqual(['a.png', 'b.png'])
  })

  it('rejects a payload missing the parts a drop needs', () => {
    const transfer = fake_data_transfer()
    transfer.setData(content_attachment_drag_type, JSON.stringify({ file_name: 'a.png' }))

    expect(get_content_attachment_drag_data(transfer as unknown as DataTransfer)).toBeNull()
  })
})

describe('markdown shorthand', () => {
  it('prefixes an image reference with !', () => {
    expect(content_attachment_markdown({ file_name: 'a.png', is_image: true, url: '/a.png' })).toBe('![](a.png)')
  })

  it('leaves a non-image reference as a plain link', () => {
    expect(content_attachment_markdown({ file_name: 'a.zip', is_image: false, url: '/a.zip' })).toBe('[](a.zip)')
  })

  it('uses the same plain-link form for a folder', () => {
    expect(content_folder_markdown('cards')).toBe('[](cards)')
  })

  it('keeps nested paths intact', () => {
    expect(content_folder_markdown('a/b')).toBe('[](a/b)')
  })
})
