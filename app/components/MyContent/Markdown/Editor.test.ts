import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { expect, it, vi } from 'vitest'
import { computed, effectScope, nextTick, reactive, ref, watch } from 'vue'

it('rejects a file drop if reference reconciliation starts while reading the dropped files', async () => {
  const source = readFileSync(new URL('./Editor.vue', import.meta.url), 'utf8')
  const handler = source.slice(source.indexOf('async function on_drop('), source.indexOf('\n// Bound to dragenter'))
  const props = { readonly: false }
  const emit = vi.fn()
  const insert_at_position = vi.fn()
  let finish!: (files: { file_name: string }[]) => void
  const { on_drop } = runInNewContext(`${ts.transpile(handler)}; ({ on_drop })`, {
    props, emit, insert_at_position, drag_over: { value: true },
    attachment_picks_from_data_transfer: () => new Promise((resolve) => {
      finish = resolve
    }),
    editor: { position_at_coords: () => 0 },
  })
  const pending = on_drop({ dataTransfer: null, clientX: 0, clientY: 0 })
  props.readonly = true
  finish([{ file_name: 'a.txt' }])
  await pending
  expect(emit).not.toHaveBeenCalled()
  expect(insert_at_position).not.toHaveBeenCalled()
})

it('shares the preview audience across inline and fullscreen while keeping edit outside the fullscreen mode switch', () => {
  // Execute the actual mode bindings: a duplicate planner would not catch
  // a fullscreen switch accidentally overwriting the editor visibility mode.
  const source = readFileSync(new URL('./Editor.vue', import.meta.url), 'utf8')
  const setup = source.slice(source.indexOf('const editor_mode ='), source.indexOf('const split_ratio ='))
  const state = runInNewContext(`${ts.transpile(setup)}; ({ editor_mode, preview_audience, fullscreen, display_mode, visible_modes })`, { ref, computed })
  expect(state.visible_modes.value.map((mode: { label: string }) => mode.label)).toEqual(['编辑', '天子上朝', '微服私访'])
  expect(state.display_mode.value).toBe('edit')
  state.display_mode.value = 'public'
  expect(state.editor_mode.value).toBe('preview')
  expect(state.preview_audience.value).toBe('public')
  state.fullscreen.value = true
  expect(state.visible_modes.value.map((mode: { label: string }) => mode.label)).toEqual(['天子上朝', '微服私访'])
  expect(state.display_mode.value).toBe('public')
  state.display_mode.value = 'private'
  state.fullscreen.value = false
  expect(state.display_mode.value).toBe('private')
  expect(state.editor_mode.value).toBe('preview')
  state.display_mode.value = 'edit'
  state.fullscreen.value = true
  expect(state.display_mode.value).toBe('private')
  state.display_mode.value = 'public'
  expect(state.editor_mode.value).toBe('edit')
  state.fullscreen.value = false
  expect(state.display_mode.value).toBe('edit')
  expect(state.preview_audience.value).toBe('public')
  // The binding is part of the UI contract; rendering is checked in Chrome.
  expect(source).toContain(':public-view="preview_audience === \'public\'"')
})

it('closes and clears a full-image lightbox when switching the preview audience', async () => {
  // Run the actual preview watcher so a lingering private image cannot survive
  // the public-view prop change, even before the new v-html subtree is patched.
  const source = readFileSync(new URL('./Preview.vue', import.meta.url), 'utf8')
  const setup = source.slice(source.indexOf('watch(() => props.publicView'), source.indexOf('/** Saves a plaintext'))
  const props = reactive({ publicView: false })
  const preview_visible = ref(true)
  const preview_images = ref(['/private-image'])
  const preview_index = ref(2)
  const scope = effectScope()
  try {
    scope.run(() => runInNewContext(setup, { watch, props, preview_visible, preview_images, preview_index }))
    props.publicView = true
    await nextTick()
    expect(preview_visible.value).toBe(false)
    expect(preview_images.value).toEqual([])
    expect(preview_index.value).toBe(0)
  }
  finally {
    scope.stop()
  }
})
