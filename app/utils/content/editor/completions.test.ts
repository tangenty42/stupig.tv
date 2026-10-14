import type { EditorView } from '@codemirror/view'
import type { ContentStoryAttachment, ContentStorySummary } from '@shared/types/content'
import { closeBrackets, CompletionContext, insertBracket } from '@codemirror/autocomplete'
import { EditorState } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import { reference_completion_source } from '~/utils/content/editor/completions'
import { editor_close_brackets, editor_markdown_lang } from '~/utils/content/editor/language'

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

const stories: ContentStorySummary[] = [1, 2].map(id => ({
  id, title: `档案${id}`, labels: ['#夯'], event_precision: 'day', event_dates: [],
  created_at: '', updated_at: '', desc: null, cover: null, cover_label: null, cover_version: null, cover_url: null,
}))
const source = reference_completion_source({
  stories: () => stories,
  story_id: () => 1,
  attachments: () => attachments,
  folders: () => folders,
})

/** Run the source as CodeMirror would, with the cursor at the end of `doc`. */
function complete(doc: string, explicit = false, pos = doc.length) {
  const state = EditorState.create({ doc, extensions: [editor_markdown_lang] })
  return source(new CompletionContext(state, pos, explicit))
}

/** The option labels the source offers, in the order it returns them. */
function labels(doc: string) {
  return complete(doc)?.options.map(option => option.label)
}

describe('attachment destination completion', () => {
  it('offers files and folders together inside an image destination', () => {
    const result = labels('![](att://')

    expect(result).toContain('cards')
    expect(result).not.toContain('cards/sub')
    expect(result).not.toContain('cards/1.png')
  })

  it('offers them inside a link destination too', () => {
    expect(labels('[](att://ca')).toContain('cards')
  })

  it('marks folders apart from files and images', () => {
    const options = complete('![](att://')!.options
    const by_label = (label: string) => options.find(option => option.label === label)

    expect(by_label('cards')).toMatchObject({ type: 'folder', detail: '文件夹' })
    expect(by_label('solo.png')).toMatchObject({ type: 'image', detail: '图片' })
    expect(by_label('note.txt')).toMatchObject({ type: 'file', detail: '附件' })
  })

  it('inserts a folder without a trailing slash, so the shorthand stays canonical', () => {
    expect(apply('![](att://', 'cards')).toEqual({ doc: '![](att://cards)', cursor: '![](att://cards'.length })
  })

  it('orders folders and files naturally, matching the attachment list', () => {
    const result = complete('![](att://cards/')!.options.map(option => option.label)

    // 10.png after 2.png, and the folders before their own children.
    expect(result).toEqual([
      '1.png',
      '2.png',
      '10.png',
      'sub',
    ])
  })

  it('keeps firing past a folder prefix so files inside can be reached', () => {
    const result = labels('![](att://cards/')

    // Drilling into an accepted folder must not end the completion; the slash
    // is part of the path, not a sign of a non-attachment destination.
    expect(result).toContain('1.png')
    expect(result).toContain('sub')
    expect(result).not.toContain('solo.png')
  })

  it('replaces only the typed destination, leaving the brackets alone', () => {
    const result = complete('![alt](att://ca')!

    expect(result.from).toBe('![alt](att://'.length)
    expect(result.to).toBe('![alt](att://ca'.length)
  })

  it('replaces only the last segment once a folder prefix is typed', () => {
    const result = complete('![alt](att://cards/')!

    expect(result.from).toBe('![alt](att://cards/'.length)
    expect(result.to).toBe('![alt](att://cards/'.length)
    expect((result.validFor as RegExp).test('/')).toBe(false)
  })

  it('stays out of the way once the destination is not a bare path', () => {
    // A scheme, an anchor, a story reference or a closed paren all mean the
    // author is not naming an attachment any more.
    expect(complete('![](https://example.com/')).toBeNull()
    expect(complete('![](#anchor')).toBeNull()
    expect(complete('![](a.png')).toBeNull()
    expect(complete('![](a.png)')).toBeNull()
  })

  it('does not fire for an absolute path', () => {
    expect(complete('![](/abs')).toBeNull()
  })

  it('does not fire outside a destination', () => {
    expect(complete('just prose ')).toBeNull()
  })
  it('shows both fixed sections for @ and explicit empty destinations', () => {
    expect(complete('[](')).toBeNull()
    expect(complete('[](', true)?.options.map(item => item.section)).toContainEqual({ name: '蠢猪档案', rank: 0 })
    expect(labels('@')).toEqual(['@档案2', '@cards', '@note.txt', '@solo.png'])
    expect(complete('@')?.options.find(item => item.label === '@cards')?.section).toEqual({ name: '附件', rank: 1 })
    expect(labels('[](content://')).toEqual(['档案2'])
  })
  it.each(['[]', '![]', '[说明]'])('automatically completes %s when closeBrackets adds the closing parenthesis', (prefix) => {
    const state = EditorState.create({
      doc: prefix,
      selection: { anchor: prefix.length },
      extensions: [editor_markdown_lang, editor_close_brackets, closeBrackets()],
    })
    const typed = insertBracket(state, '(')!
    expect(typed.state.doc.toString()).toBe(`${prefix}()`)
    expect(typed.state.selection.main.head).toBe(prefix.length + 1)
    const result = source(new CompletionContext(typed.state, typed.state.selection.main.head, false))
    expect(result?.options.map(item => item.label)).toEqual(['档案2', 'cards', 'note.txt', 'solo.png'])
    expect(result?.from).toBe(prefix.length + 1)
  })
  it.each([
    ['[](@)', ['@档案2', '@cards', '@note.txt', '@solo.png']],
    ['![](att://)', ['cards', 'note.txt', 'solo.png']],
    ['[](att://cards/)', ['1.png', '2.png', '10.png', 'sub']],
    ['[](content://)', ['档案2']],
  ])('completes inside an already closed destination: %s', (doc, expected) => {
    expect(complete(doc, false, doc.length - 1)?.options.map(item => item.label)).toEqual(expected)
    expect(complete(doc)).toBeNull()
  })
  it('keeps the automatically inserted closing parenthesis when accepting an empty destination completion', () => {
    expect(apply('[](', 'solo.png', ')')).toEqual({ doc: '[](att://solo.png)', cursor: '[](att://solo.png)'.length })
    expect(apply('![](', 'cards', ')')).toEqual({ doc: '![](att://cards)', cursor: '![](att://cards'.length })
  })
  it.each(['a@b', '`@query', '```md\n@query', '    @query', '<a href="@query', '<pre>\n@query', '<script>\n@query'])('does not complete prose/code/HTML: %s', (doc) => {
    expect(complete(doc)).toBeNull()
  })
  it('expands bare references and reuses closeBrackets destinations', () => {
    expect(apply('@', '@solo.png').doc).toBe('![](att://solo.png)')
    expect(apply('@', '@note.txt').doc).toBe('[](att://note.txt)')
    expect(apply('@', '@档案2').doc).toBe('[](content://档案2)')
    expect(apply('@', '@cards')).toEqual({ doc: '[](att://cards)', cursor: '[](att://cards'.length })
    expect(apply('![](@', '@solo.png', ')')).toEqual({ doc: '![](att://solo.png)', cursor: '![](att://solo.png)'.length })
    expect(apply('[](att://cards/', '2.png', ')').doc).toBe('[](att://cards/2.png)')
    expect(apply('[](content://', '档案2', ')').doc).toBe('[](content://档案2)')
  })
})

/** Drive the real completion callback with CodeMirror state, without requiring a DOM. */
function apply(before: string, label: string, after = '') {
  const result = complete(before + after, false, before.length)!
  const option = result.options.find(item => item.label === label)!
  let state = EditorState.create({ doc: before + after })
  const view = {
    get state() { return state },
    dispatch(spec: Parameters<EditorState['update']>[0]) { state = state.update(spec).state },
  } as unknown as EditorView
  if (typeof option.apply !== 'function')
    throw new Error('Reference completions must control cursor placement')
  option.apply(view, option, result.from, result.to!)
  return { doc: state.doc.toString(), cursor: state.selection.main.head }
}
