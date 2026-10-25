import type { EditorView } from '@codemirror/view'
import type { ContentStoryAttachment, ContentStorySummary } from '@shared/types/content'
import { closeBrackets, CompletionContext, insertBracket } from '@codemirror/autocomplete'
import { EditorState } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import { compare_reference_completions, reference_completion_source } from '~/utils/content/editor/completions'
import { editor_close_brackets, editor_markdown_lang } from '~/utils/content/editor/language'
import { attachment_item_presentation, folder_item_presentation } from '~/utils/content/item-presentation'
import { project_workspace_rows } from '~/utils/content/workspace'

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
  it('uses the workspace directory order in both source options and CodeMirror comparisons', () => {
    const files = ['10.txt', '2.txt', '1.txt'].map(name => attachment(name, false))
    const directories = ['z10', 'z2']
    const source = reference_completion_source({ stories: () => [], story_id: () => 1, attachments: () => files, folders: () => directories })
    const nodes = [
      ... directories.map((name, index) => ({ id: index + 2, parent_id: 1, name, path: name, kind: 'folder' as const, version: 'v1' })),
      ... files.map((file, index) => ({ id: index + 4, parent_id: 1, name: file.file_name, path: file.file_name, kind: 'file' as const, version: 'v1', attachment: file })),
    ]
    const expected = project_workspace_rows(nodes, [], 1, new Set()).map(row => row.name)
    expect(expected).toEqual(['z2', 'z10', '1.txt', '2.txt', '10.txt'])
    for (const doc of ['[](att://', '@']) {
      const options = source(new CompletionContext(EditorState.create({ doc, extensions: [editor_markdown_lang] }), doc.length, false))!.options
      expect(options.map(option => option.displayLabel)).toEqual(expected)
      // CodeMirror applies its own comparator after source sorting; verify that
      // step cannot restore lexicographic order (1, 10, 2) or put files first.
      expect([... options].reverse().sort(compare_reference_completions).map(option => option.displayLabel)).toEqual(expected)
    }
  })

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

    expect(by_label('cards')).toMatchObject({ type: 'folder', presentation: folder_item_presentation() })
    expect(by_label('solo.png')).toMatchObject({ type: 'image', presentation: attachment_item_presentation(attachments[3]!) })
    expect(by_label('note.txt')).toMatchObject({ type: 'file', presentation: attachment_item_presentation(attachments[4]!) })
    expect(options.every(option => option.detail === undefined)).toBe(true)
  })

  it('mixes private files into the attachment section and inserts logical att references', () => {
    const private_source = reference_completion_source({
      stories: () => [],
      story_id: () => 1,
      folders: () => [],
      attachments: () => [
        attachment('b-public.txt', false),
        { ... attachment('c-private.png.good', true), is_private: true, url: '/api/content/private-attachments/11?version=v1' },
        { ... attachment('a-denied.pdf.good', false), is_private: true, url: null },
      ],
    })
    const state = EditorState.create({ doc: '@', extensions: [editor_markdown_lang] })
    const result = private_source(new CompletionContext(state, 1, false))!
    expect(result.options.map(option => option.label)).toEqual(['@a-denied.pdf.good', '@b-public.txt', '@c-private.png.good'])
    expect(result.options.every(option => option.section === result.options[0]?.section)).toBe(true)
    expect(result.options[0]).toMatchObject({ type: 'encrypted-denied', presentation: { icon: 'lucide:lock', tone: 'private' } })
    expect(result.options[2]).toMatchObject({ type: 'encrypted', presentation: { icon: 'lucide:lock', tone: 'private' } })
    expect(apply('@', '@c-private.png.good', '', private_source).doc).toBe('![](att://c-private.png.good)')
    expect(apply('@', '@a-denied.pdf.good', '', private_source).doc).toBe('[](att://a-denied.pdf.good)')
    expect(apply('[](att://', 'c-private.png.good', ')', private_source).doc).toBe('[](att://c-private.png.good)')
  })

  it('does not pair ordinary files with same-name private attachments in reference completion', () => {
    const public_file = attachment('报告.pdf', false)
    const private_file = { ... attachment('报告.pdf.good', false), is_private: true }
    const reference_source = reference_completion_source({ stories: () => stories, story_id: () => 1, folders: () => [], attachments: () => [public_file, private_file] })
    const state = EditorState.create({ doc: '@', extensions: [editor_markdown_lang] })
    const options = reference_source(new CompletionContext(state, 1, false))!.options
    expect(options.find(option => option.label === '@档案2')).toMatchObject({ displayLabel: '档案2', presentation: { icon: 'lucide:book-open', tone: 'muted' } })
    expect(options.find(option => option.label === '@报告.pdf')).toMatchObject({ displayLabel: '报告.pdf', presentation: attachment_item_presentation(public_file) })
    expect(options.every(option => option.detail === undefined)).toBe(true)
    expect(apply('@', '@报告.pdf', '', reference_source).doc).toBe('[](att://报告.pdf)')
    expect(apply('@', '@档案2', '', reference_source).doc).toBe('[](content://档案2)')
  })

  it('inserts a folder without a trailing slash, so the shorthand stays canonical', () => {
    expect(apply('![](att://', 'cards')).toEqual({ doc: '![](att://cards)', cursor: '![](att://cards'.length })
  })

  it('orders folders and files naturally, matching the attachment list', () => {
    const result = complete('![](att://cards/')!.options.map(option => option.label)

    // Folders first, then numeric file names in natural order.
    expect(result).toEqual([
      'sub',
      '1.png',
      '2.png',
      '10.png',
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
    ['[](att://cards/)', ['sub', '1.png', '2.png', '10.png']],
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
function apply(before: string, label: string, after = '', completion_source = source) {
  let state = EditorState.create({ doc: before + after, extensions: [editor_markdown_lang] })
  const result = completion_source(new CompletionContext(state, before.length, false))!
  const option = result.options.find(item => item.label === label)!
  const view = {
    get state() { return state },
    dispatch(spec: Parameters<EditorState['update']>[0]) { state = state.update(spec).state },
  } as unknown as EditorView
  if (typeof option.apply !== 'function')
    throw new Error('Reference completions must control cursor placement')
  option.apply(view, option, result.from, result.to!)
  return { doc: state.doc.toString(), cursor: state.selection.main.head }
}
