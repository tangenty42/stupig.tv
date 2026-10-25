import { readFileSync } from 'node:fs'
import { setImmediate as settle } from 'node:timers/promises'
import { runInNewContext } from 'node:vm'
import { split_attachment_editable_name } from '@shared/content-markdown'
import ts from 'typescript'
import { expect, it, vi } from 'vitest'
import { computed, effectScope, nextTick, reactive, ref, shallowRef, watch } from 'vue'
import { normalize_editor_crop, suggested_image_name } from '~/utils/content/image-edit'

it('preserves the crop on same-size repaint and resets it on changed dimensions', async () => {
  // Exercise the actual SFC watcher wiring with Vue; a duplicate watcher in this
  // test would not catch accidentally watching a freshly allocated array again.
  const source = readFileSync(new URL('./ImageEditor.vue', import.meta.url), 'utf8')
  const watcher = source.split('\n').find(line => line.startsWith('watch(') && line.includes('natural_size'))!
  expect(watcher).toBeTruthy()
  const natural_size = ref({ width: 800, height: 600 })
  const cancel_crop = vi.fn()
  const scope = effectScope()
  try {
    scope.run(() => runInNewContext(watcher, { watch, natural_size, cancel_crop }))
    natural_size.value = { width: 800, height: 600 }
    await nextTick()
    expect(cancel_crop).not.toHaveBeenCalled()
    natural_size.value = { width: 400, height: 600 }
    await nextTick()
    expect(cancel_crop).toHaveBeenCalledOnce()
  }
  finally {
    scope.stop()
  }
})

it('edits only the copy stem and submits an AVIF filename through the dialog save handler', async () => {
  // Execute the dialog setup/save handlers: testing the naming utility alone
  // cannot catch an editable suffix or emitting the stem without its suffix.
  const source = readFileSync(new URL('./ImageEditor.vue', import.meta.url), 'utf8')
  const setup = source.slice(source.indexOf('const mode = '), source.indexOf('\nconst limits ='))
  const emit = vi.fn()
  const scope = effectScope()
  try {
    const dialog = scope.run(() => runInNewContext(`${ts.transpile(setup)}; ({ mode, output_name, display_name, original_name, save })`, {
      ref, computed, watch, suggested_image_name, split_attachment_editable_name,
      props: { visible: false, attachment: { file_name: 'docs/原图.JPG.good' } }, emit,
    }))
    expect(dialog.mode.value).toBe('overwrite')
    dialog.mode.value = 'copy'
    await nextTick()
    expect(dialog.output_name.value).toBe('原图_副本')
    const file = new File(['pixels'], 'edited.png', { type: 'image/png' })
    dialog.output_name.value = '改名.v2'
    dialog.save(file)
    expect(emit).toHaveBeenLastCalledWith('save', file, 'copy', '改名.v2.avif', 'avif')
    dialog.mode.value = 'overwrite'
    await nextTick()
    expect(dialog.display_name.value + dialog.original_name.value.locked).toBe('原图.JPG.good')
    dialog.mode.value = 'copy'
    await nextTick()
    expect(dialog.display_name.value).toBe('改名.v2')
    dialog.output_name.value = '   '
    dialog.save(file)
    expect(emit).toHaveBeenCalledOnce()
    dialog.mode.value = 'redacted'
    await nextTick()
    expect(dialog.output_name.value).toBe('原图_删减版')
    dialog.save(file)
    expect(emit).toHaveBeenLastCalledWith('save', file, 'redacted', 'docs/原图.JPG.good', 'avif')
    expect(source).toContain(':suffix="mode === \'copy\' ? \'.avif\' : original_name.locked"')
    expect(source).toContain('on_save: save')
  }
  finally {
    scope.stop()
  }
})

it.each(['copy', 'overwrite', 'redacted'])('resets only the local canvas in %s mode and preserves it across save-mode changes', async (mode) => {
  const source = readFileSync(new URL('./ImageEditor.vue', import.meta.url), 'utf8')
  const setup = source.slice(source.indexOf('const mode = '), source.indexOf('\nconst limits ='))
  const emit = vi.fn()
  let accept_reset = () => {}
  const scope = effectScope()
  try {
    const dialog = scope.run(() => runInNewContext(`${ts.transpile(setup)}; ({ mode, source_url, original_url, base_ready, input_basis, request_reset, save, props })`, {
      ref, computed, watch, suggested_image_name, split_attachment_editable_name,
      confirm_require: (_event: Event, _message: string, accept: () => void) => { accept_reset = accept },
      props: { visible: false, attachment: { file_name: 'copy.avif' } }, emit,
    }))
    dialog.mode.value = mode
    await nextTick()
    dialog.source_url.value = '/current.avif'
    dialog.original_url.value = '/own-archive?role=original'
    dialog.base_ready.value = true
    dialog.props.visible = true
    dialog.request_reset({ currentTarget: {} })
    expect(dialog.source_url.value).toBe('/current.avif')
    accept_reset()
    const archive_input = dialog.source_url.value
    expect(archive_input).toContain('/own-archive?role=original&editor_reset=')
    expect(dialog.input_basis.value).toBe('original')
    expect(dialog.mode.value).toBe(mode)
    expect(emit).not.toHaveBeenCalled()
    dialog.mode.value = 'redacted'
    await nextTick()
    expect(dialog.source_url.value).toBe(archive_input)
    dialog.mode.value = 'copy'
    await nextTick()
    expect(dialog.source_url.value).toBe(archive_input)
    const file = new File(['edited pixels'], 'edited.png', { type: 'image/png' })
    dialog.save(file)
    expect(emit).toHaveBeenLastCalledWith('save', file, 'copy', 'copy_副本.avif', 'original')
    dialog.mode.value = 'overwrite'
    await nextTick()
    expect(dialog.source_url.value).toBe(archive_input)
    expect(source).toContain('label="回退原图"')
  }
  finally {
    scope.stop()
  }
})

it.each(['copy', 'overwrite', 'redacted'])('keeps decode and authorized archive guards for reset in %s mode', async (mode) => {
  const source = readFileSync(new URL('./ImageEditor.vue', import.meta.url), 'utf8')
  const setup = source.slice(source.indexOf('const mode = '), source.indexOf('\nconst limits ='))
  const scope = effectScope()
  try {
    const dialog = scope.run(() => runInNewContext(`${ts.transpile(setup)}; ({ mode, source_url, original_url, base_ready, input_basis, reset_source })`, {
      ref, computed, watch, suggested_image_name, split_attachment_editable_name,
      props: { visible: false, attachment: { file_name: 'copy.avif' } }, emit: vi.fn(),
    }))
    dialog.mode.value = mode
    await nextTick()
    dialog.source_url.value = '/current.avif'
    dialog.original_url.value = '/own-archive?role=original'
    dialog.reset_source()
    expect(dialog.source_url.value).toBe('/current.avif')
    expect(dialog.input_basis.value).toBe('avif')
    dialog.base_ready.value = true
    dialog.original_url.value = null
    dialog.reset_source()
    expect(dialog.source_url.value).toBe('/current.avif')
    expect(dialog.input_basis.value).toBe('avif')
  }
  finally {
    scope.stop()
  }
})

it('resets only the redacted canvas to the archive and retains the redacted save destination', async () => {
  const source = readFileSync(new URL('./ImageEditor.vue', import.meta.url), 'utf8')
  const setup = source.slice(source.indexOf('const mode = '), source.indexOf('\nconst limits ='))
  const scope = effectScope()
  const emit = vi.fn()
  let accept = () => {}
  try {
    const dialog = scope.run(() => runInNewContext(`${ts.transpile(setup)}; ({ mode, modes, source_url, original_url, base_ready, request_reset, input_basis, display_name, props, save })`, {
      ref, computed, watch, suggested_image_name, split_attachment_editable_name,
      confirm_require: (_event: Event, _message: string, action: () => void) => { accept = action },
      props: { visible: false, redacted: true, attachment: { file_name: 'docs/photo.png.good' } }, emit,
    }))
    expect(dialog.mode.value).toBe('redacted')
    expect(dialog.modes.map((mode: { value: string }) => mode.value)).toEqual(['copy', 'overwrite'])
    dialog.source_url.value = '/read?role=redacted_avif'
    dialog.original_url.value = '/read?role=original'
    dialog.base_ready.value = true
    dialog.props.visible = true
    dialog.request_reset({ currentTarget: {} })
    expect(emit).not.toHaveBeenCalled()
    accept()
    expect(emit).not.toHaveBeenCalled()
    expect(dialog.source_url.value).toContain('/read?role=original&editor_reset=')
    expect(dialog.input_basis.value).toBe('original')
    expect(dialog.display_name.value).toBe('photo')
    dialog.save(new File(['edited'], 'pixels.png', { type: 'image/png' }))
    expect(emit).toHaveBeenLastCalledWith('save', expect.any(File), 'redacted', 'docs/photo.png.good', 'original')
  }
  finally {
    scope.stop()
  }
})

function mount_editor() {
  // Run the complete component setup with only canvas/viewport/API boundaries
  // mocked, so the merged dialog must connect source loading and export itself.
  const source = readFileSync(new URL('./ImageEditor.vue', import.meta.url), 'utf8')
  const setup = source.slice(source.indexOf('const { error: toast_error }'), source.indexOf('</script>'))
  const props = reactive({ visible: false, pending: false, redacted: true,
    attachment: { id: 1, file_name: 'photo.png.good', url: '/api/content/attachments/1?version=v1' } })
  const api = vi.fn().mockResolvedValue({ avif_url: '/read?role=redacted_avif', original_url: '/read?role=original', original_reason: '' })
  const emit = vi.fn()
  const confirm = vi.fn()
  const release = vi.fn()
  let unmount = () => {}
  let session_options!: { source_url: () => string | null, file_name: () => string, output_mime: () => string, on_save: (file: File) => void, on_ready: (bitmap: { width: number, height: number }) => void }
  const scope = effectScope()
  const state = scope.run(() => runInNewContext(`${ts.transpile(setup.replaceAll('import.meta.server', 'false'))}; ({ source_url, base_ready, mode, request_reset })`, {
    props, emit, ref, shallowRef, computed, watch, nextTick, split_attachment_editable_name, suggested_image_name, normalize_editor_crop,
    settings: { app: { content: { imageEditor: {} } } },
    useMyToast: () => ({ error: vi.fn() }), useMyConfirm: () => ({ confirm_require: confirm }), useApi: () => ({ content: { image_editor_source: api } }),
    window: { location: { origin: 'http://localhost:3042' }, addEventListener: vi.fn(), removeEventListener: vi.fn() }, URL,
    onBeforeUnmount: (action: () => void) => { unmount = action },
    useImageEditSession: (options: typeof session_options) => {
      session_options = options
      return { working: ref(false), loading: ref(false), load_error: ref(''), natural_size: ref({ width: 32, height: 24 }),
        source_bitmap: ref({ width: 32, height: 24 }), can_undo: ref(false), can_redo: ref(false), generation: 1,
        load_source: vi.fn(() => options.on_ready({ width: 32, height: 24 })), release_source: release }
    },
    useImageEditorViewport: () => ({ scale: ref(1), pan_state: ref(null), cursor_pos: ref(null), space_held: ref(false), reset: vi.fn() }),
  }))!
  return { state, props, api, emit, confirm, release, scope, session: () => session_options, unmount: () => unmount() }
}

it('loads the dedicated redacted source and routes the canvas export through the merged save handler', async () => {
  const editor = mount_editor()
  try {
    editor.props.visible = true
    await nextTick()
    await nextTick()
    expect(editor.api).toHaveBeenCalledExactlyOnceWith(1, 'v1', true)
    await vi.waitFor(() => expect(editor.session().source_url()).toBe('/read?role=redacted_avif'))
    expect(editor.session().file_name()).toBe('edited.png')
    expect(editor.session().output_mime()).toBe('image/png')
    expect(editor.state.base_ready.value).toBe(true)
    const file = new File(['pixels'], 'edited.png', { type: 'image/png' })
    editor.session().on_save(file)
    expect(editor.emit).toHaveBeenLastCalledWith('save', file, 'redacted', 'photo.png.good', 'avif')
    expect(editor.session().source_url()).toBe('/read?role=redacted_avif')
  }
  finally {
    editor.scope.stop()
  }
})

it.each([true, false])('uses the same archive reset without deleting saved redacted pixels (existing variant: %s)', async (has_redacted) => {
  const editor = mount_editor()
  Object.assign(editor.props.attachment, { has_redacted })
  const source = readFileSync(new URL('./Workspace.vue', import.meta.url), 'utf8')
  try {
    editor.props.visible = true
    await vi.waitFor(() => expect(editor.state.base_ready.value).toBe(true))
    editor.state.request_reset({ currentTarget: {} })
    expect(editor.confirm.mock.calls[0]![1]).toContain('丢弃未保存的编辑')
    expect(editor.emit).not.toHaveBeenCalled()
    expect(editor.session().source_url()).toBe('/read?role=redacted_avif')
    editor.confirm.mock.calls[0]![2]()
    expect(editor.props.visible).toBe(true)
    expect(editor.emit).not.toHaveBeenCalled()
    expect(editor.session().source_url()).toContain('/read?role=original&editor_reset=')
    expect(source).not.toContain('@delete-redacted=')
    const file = new File(['pixels'], 'edited.png', { type: 'image/png' })
    editor.session().on_save(file)
    expect(editor.emit).toHaveBeenLastCalledWith('save', file, 'redacted', 'photo.png.good', 'original')
  }
  finally {
    editor.scope.stop()
  }
})

it.each(['pending', 'closed', 'changed', 'unmounted'])('ignores a stale redacted restore confirmation when %s', async (change) => {
  const editor = mount_editor()
  try {
    editor.props.visible = true
    await vi.waitFor(() => expect(editor.state.base_ready.value).toBe(true))
    editor.state.request_reset({ currentTarget: {} })
    const accept = editor.confirm.mock.calls[0]![2]
    if (change === 'pending')
      editor.props.pending = true
    else if (change === 'closed')
      editor.props.visible = false
    else if (change === 'changed')
      editor.props.attachment = { id: 2, file_name: 'other.png.good', url: '/api/content/attachments/2?version=v2' }
    else
      editor.unmount()
    await nextTick()
    const current = editor.session().source_url()
    accept()
    expect(editor.session().source_url()).toBe(current)
    expect(editor.emit).not.toHaveBeenCalled()
  }
  finally {
    editor.scope.stop()
  }
})

it('discards source responses from an older attachment or a closed merged dialog', async () => {
  const editor = mount_editor()
  let first!: (value: { avif_url: string, original_url: null }) => void
  let second!: (value: { avif_url: string, original_url: null }) => void
  try {
    editor.api.mockImplementationOnce(() => new Promise((resolve) => {
      first = resolve
    })).mockImplementationOnce(() => new Promise((resolve) => {
      second = resolve
    }))
    editor.props.visible = true
    await nextTick()
    editor.props.attachment = { id: 2, file_name: 'other.png.good', url: '/api/content/attachments/2?version=v2' }
    await nextTick()
    second({ avif_url: '/newest?role=redacted_avif', original_url: null })
    await nextTick()
    await nextTick()
    first({ avif_url: '/old?role=redacted_avif', original_url: null })
    await settle()
    expect(editor.session().source_url()).toBe('/newest?role=redacted_avif')
    editor.props.visible = false
    await nextTick()
    expect(editor.session().source_url()).toBeNull()
    expect(editor.release).toHaveBeenCalled()
    editor.api.mockImplementationOnce(() => new Promise((resolve) => {
      first = resolve
    }))
    editor.props.visible = true
    await nextTick()
    editor.unmount()
    first({ avif_url: '/after-unmount', original_url: null })
    await settle()
    expect(editor.session().source_url()).toBeNull()
    expect(editor.emit).not.toHaveBeenCalled()
  }
  finally {
    editor.scope.stop()
  }
})
