import type { ContentStoryAttachment } from '@shared/types/content'
import type { AttachmentMenuItem } from './attachment-list'
import type { WorkspaceListRow } from './workspace'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { content_attachment_drag_type, content_attachment_markdown, content_folder_drag_type, content_folder_markdown, content_selection_markdown, get_content_attachment_drag_data, get_content_folder_drag_data, set_content_attachment_drag_data, set_content_folder_drag_data } from '~/utils/content/attachment-drag'
import { attachment_action_item, attachment_batch_action, attachment_menu_context, attachment_privacy_actions } from './attachment-list'

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
    is_encrypted: false,
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
  it('keeps a private file with a denied URL in the shared drag and reference flow', () => {
    const file = attachment({ file_name: 'docs/secret.pdf.good', is_private: true, is_image: false, url: null })
    const data = get_content_attachment_drag_data(start_attachment_drag(file) as unknown as DataTransfer)
    expect(data).toMatchObject({ file_name: file.file_name, is_image: false, url: null })
    expect(content_attachment_markdown(data!)).toBe('[](att://docs/secret.pdf.good)')
  })

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
    expect(content_attachment_markdown({ file_name: 'a.png', is_image: true, url: '/a.png' })).toBe('![](att://a.png)')
  })

  it('leaves a non-image reference as a plain link', () => {
    expect(content_attachment_markdown({ file_name: 'a.zip', is_image: false, url: '/a.zip' })).toBe('[](att://a.zip)')
  })

  it('uses the same plain-link form for a folder', () => {
    expect(content_folder_markdown('cards')).toBe('[](att://cards)')
  })

  it('keeps nested paths intact', () => {
    expect(content_folder_markdown('a/b')).toBe('[](att://a/b)')
  })
})

it.each(['folder', 'image', 'file'])('inserts the same entire selection as the copy menu when dragging its %s row', async (origin) => {
  const files = [attachment({ file_name: 'image.png' }), attachment({ file_name: 'note.txt', is_image: false }), attachment({ file_name: 'private.pdf.good', is_image: false, is_private: true, url: null })]
  const rows: WorkspaceListRow[] = [
    { key: 'folder', name: 'docs', path: 'docs', parent_id: 1, depth: 0, node: { id: 2, parent_id: 1, name: 'docs', path: 'docs', kind: 'folder', version: 'v1' } },
    ... files.map((file, i) => ({ key: i === 0 ? 'image' : i === 1 ? 'file' : 'private', name: file.file_name, path: file.file_name, parent_id: 1, depth: 0, node: { id: i + 3, parent_id: 1, name: file.file_name, path: file.file_name, kind: 'file' as const, version: 'v1', attachment: file } })),
  ]
  // Execute both SFC entry points: this checks that drag, clipboard and editor
  // actually use the shared generator, without needing a DOM or CodeMirror view.
  const source = readFileSync(new URL('../../components/MyContent/Attachment/Workspace.vue', import.meta.url), 'utf8')
  const drag = source.slice(source.indexOf('function drag('), source.indexOf('\nasync function drop('))
  const menu = source.slice(source.indexOf('function menu_for('), source.indexOf('\nfunction replaced('))
  const editor = readFileSync(new URL('../../components/MyContent/Markdown/Editor.vue', import.meta.url), 'utf8')
  const drop = editor.slice(editor.indexOf('async function on_drop('), editor.indexOf('\n// Bound to dragenter'))
  let copied = ''
  const inserted: { markdown: string, position: number }[] = []
  const model = {
    selected: new Set(rows.map(row => row.key)),
    get selected_rows() { return rows.filter(row => this.selected.has(row.key)) },
    drag_ids: [] as number[],
    readonly: false,
    capabilities: () => ({ move: true, delete: true, private: true, reasons: { move: [], delete: [], private: [] } }),
  }
  const props = { readonly: false }
  const context = runInNewContext(`${ts.transpile(`${drag}\n${menu}\n${drop}`)}; ({drag, menu_for, on_drop})`, {
    props,
    model, attachment_action_item, attachment_batch_action, attachment_menu_context, attachment_privacy_actions,
    content_selection_markdown, content_attachment_markdown, content_folder_markdown,
    set_content_attachment_drag_data, set_content_folder_drag_data, get_content_attachment_drag_data, get_content_folder_drag_data,
    navigator: { clipboard: { writeText: (value: string) => { copied = value } } },
    drag_over: { value: true },
    attachment_picks_from_data_transfer: async () => [],
    editor: { position_at_coords: () => 12 },
    insert_at_position: (markdown: string, position: number) => inserted.push({ markdown, position }),
  }) as { drag: (event: DragEvent, row: WorkspaceListRow) => void, menu_for: (row: WorkspaceListRow) => AttachmentMenuItem[], on_drop: (event: DragEvent) => Promise<void> }
  const row = rows.find(row => row.key === origin)!
  const copy = context.menu_for(row).find(item => item.icon_name === 'lucide:copy')!
  copy.command!({ originalEvent: new Event('click'), item: copy })
  expect(copied).toBe('[](att://docs)\n![](att://image.png)\n[](att://note.txt)\n[](att://private.pdf.good)')
  const transfer = fake_data_transfer()
  const event = { dataTransfer: transfer, clientX: 10, clientY: 20 } as unknown as DragEvent
  context.drag(event, row)
  await context.on_drop(event)
  expect(inserted).toEqual([{ markdown: copied, position: 12 }])
  expect(model.drag_ids).toEqual([2, 3, 4, 5])
  expect(transfer.effectAllowed).toBe('copyMove')
  model.selected = new Set(['folder'])
  const single_event = { dataTransfer: fake_data_transfer(), clientX: 10, clientY: 20 } as unknown as DragEvent
  context.drag(single_event, rows[1]!)
  await context.on_drop(single_event)
  expect([... model.selected]).toEqual(['image'])
  expect(inserted[1]).toEqual({ markdown: '![](att://image.png)', position: 12 })
  props.readonly = true
  await context.on_drop(single_event)
  expect(inserted).toHaveLength(2)
})
