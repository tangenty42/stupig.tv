import type { ContentStoryAttachment } from '@shared/types/content'
import { CompletionContext } from '@codemirror/autocomplete'
import { EditorState } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import { attachment_completion_source } from '~/utils/content/editor/completions'

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

const attachments = [
  attachment('cards/1.png', true),
  attachment('cards/10.png', true),
  attachment('cards/2.png', true),
  attachment('solo.png', true),
  attachment('note.txt', false),
]

const folders = ['cards', 'cards/sub']

const source = attachment_completion_source({
  stories: () => [],
  story_id: () => 1,
  attachments: () => attachments,
  folders: () => folders,
})

/** Run the source as CodeMirror would, with the cursor at the end of `doc`. */
function complete(doc: string) {
  const state = EditorState.create({ doc })
  return source(new CompletionContext(state, doc.length, false))
}

/** The option labels the source offers, in the order it returns them. */
function labels(doc: string) {
  return complete(doc)?.options.map(option => option.label)
}

describe('attachment destination completion', () => {
  it('offers files and folders together inside an image destination', () => {
    const result = labels('![](ca')

    expect(result).toContain('cards')
    expect(result).toContain('cards/sub')
    expect(result).toContain('cards/1.png')
  })

  it('offers them inside a link destination too', () => {
    expect(labels('[](ca')).toContain('cards')
  })

  it('marks folders apart from files and images', () => {
    const options = complete('![](')!.options
    const by_label = (label: string) => options.find(option => option.label === label)

    expect(by_label('cards')).toMatchObject({ type: 'folder', detail: '文件夹' })
    expect(by_label('cards/1.png')).toMatchObject({ type: 'image', detail: '图片' })
    expect(by_label('note.txt')).toMatchObject({ type: 'file', detail: '附件' })
  })

  it('inserts a folder without a trailing slash, so the shorthand stays canonical', () => {
    const folder = complete('![](')!.options.find(option => option.label === 'cards')

    // `![](cards)` is the form the renderer recognises.
    expect(folder?.apply).toBe('cards')
  })

  it('orders folders and files naturally, matching the attachment list', () => {
    const result = complete('![](')!.options.map(option => option.label)

    // 10.png after 2.png, and the folders before their own children.
    expect(result).toEqual([
      'cards',
      'cards/1.png',
      'cards/2.png',
      'cards/10.png',
      'cards/sub',
      'note.txt',
      'solo.png',
    ])
  })

  it('keeps firing past a folder prefix so files inside can be reached', () => {
    const result = labels('![](cards/')

    // Drilling into an accepted folder must not end the completion; the slash
    // is part of the path, not a sign of a non-attachment destination.
    expect(result).toContain('cards/1.png')
    expect(result).toContain('cards/sub')
  })

  it('replaces only the typed destination, leaving the brackets alone', () => {
    const result = complete('![alt](ca')!

    expect(result.from).toBe('![alt](ca'.length - 'ca'.length)
    expect(result.to).toBe('![alt](ca'.length)
  })

  it('replaces the whole path once a folder prefix is typed', () => {
    const result = complete('![alt](cards/')!

    expect(result.from).toBe('![alt]('.length)
    expect(result.to).toBe('![alt](cards/'.length)
  })

  it('stays out of the way once the destination is not a bare path', () => {
    // A scheme, an anchor, a story reference or a closed paren all mean the
    // author is not naming an attachment any more.
    expect(complete('![](https://example.com/')).toBeNull()
    expect(complete('![](#anchor')).toBeNull()
    expect(complete('[](@档案')).toBeNull()
    expect(complete('![](a.png)')).toBeNull()
  })

  it('does not fire for an absolute path', () => {
    expect(complete('![](/abs')).toBeNull()
  })

  it('does not fire outside a destination', () => {
    expect(complete('just prose ')).toBeNull()
  })
})
