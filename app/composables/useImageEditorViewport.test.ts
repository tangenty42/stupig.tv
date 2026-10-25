import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { computed, nextTick, ref, shallowRef } from 'vue'
import { useImageEditorViewport } from './useImageEditorViewport'

beforeEach(() => {
  for (const [name, value] of Object.entries({ ref, computed, nextTick }))
    vi.stubGlobal(name, value)
})
afterEach(() => vi.unstubAllGlobals())
function setup() {
  const pointers = new Set<number>()
  const stage = { clientWidth: 400, clientHeight: 200, scrollLeft: 0, scrollTop: 0,
    getBoundingClientRect: () => ({ left: 10, top: 20 }),
    setPointerCapture: vi.fn((id: number) => pointers.add(id)), hasPointerCapture: (id: number) => pointers.has(id),
    releasePointerCapture: vi.fn((id: number) => pointers.delete(id)),
  }
  const rect = { left: 10, top: 20, width: 400, height: 200 }
  const canvas = { width: 800, height: 400, getBoundingClientRect: () => rect }
  const size = ref({ width: 800, height: 400 })
  const tool = ref<'move' | 'brush' | 'crop'>('move')
  const busy = ref(false)
  const loading = ref(false)
  const error = ref('')
  const api: ReturnType<typeof useImageEditorViewport> = useImageEditorViewport({ stage: shallowRef(stage as unknown as HTMLElement), stroke_canvas: shallowRef(canvas as unknown as HTMLCanvasElement),
    natural_size: size, busy: () => busy.value || api.pan_state.value !== null,
    loading: () => loading.value, load_error: () => error.value, tool: () => tool.value })
  return { api, stage, canvas, rect, size, tool, busy, loading, error }
}
function pointer(values: Partial<PointerEvent> = {}) {
  return { pointerId: 1, button: 0, pointerType: 'mouse', clientX: 110, clientY: 70, preventDefault: vi.fn(), ... values } as unknown as PointerEvent
}
function wheel(values: Partial<WheelEvent> = {}) {
  return { ctrlKey: true, metaKey: false, deltaMode: 0, deltaY: - 1000, clientX: 210, clientY: 120, preventDefault: vi.fn(), ... values } as unknown as WheelEvent
}

it('fits and floors display geometry and permits magnification above native size', async () => {
  const f = setup()
  f.api.fit_to_stage()
  expect(f.api.scale.value).toBe(0.5)
  await f.api.on_wheel(wheel())
  expect(f.api.scale.value).toBe(1)
  expect([f.stage.scrollLeft, f.stage.scrollTop]).toEqual([200, 100])
  await f.api.on_wheel(wheel())
  expect(f.api.scale.value).toBe(2)
  await f.api.on_wheel(wheel({ deltaY: 1000 }))
  expect(f.api.scale.value).toBe(1)
  f.size.value = { width: 801, height: 400 }
  f.api.fit_to_stage()
  expect([f.api.display_width.value, f.api.display_height.value]).toEqual([400, 199])
})

it('fits small images by enlarging them and still permits native-size zoom', async () => {
  const f = setup()
  f.size.value = { width: 32, height: 32 }
  f.api.fit_to_stage()
  expect(f.api.scale.value).toBe(6.25)
  expect([f.api.display_width.value, f.api.display_height.value]).toEqual([200, 200])
  f.api.scale.value = 1
  await f.api.on_wheel(wheel())
  expect(f.api.scale.value).toBe(2)
  expect(f.api.clamp_scale(4)).toBe(4)
  await f.api.on_wheel(wheel({ deltaY: 1000 }))
  await f.api.on_wheel(wheel({ deltaY: 1000 }))
  expect(f.api.scale.value).toBe(0.5)
})

it('allows fitting even tiny images beyond the normal zoom ceiling', () => {
  const f = setup()
  f.size.value = { width: 4, height: 4 }
  f.api.fit_to_stage()
  expect(f.api.scale.value).toBe(50)
  expect(f.api.clamp_scale(50)).toBe(50)
  expect(f.api.clamp_scale(1)).toBe(1)
})

it.each(['plain', 'busy', 'loading', 'error'])('leaves %s wheel handling to its existing owner', async (mode) => {
  const f = setup()
  f.api.fit_to_stage()
  f.busy.value = mode === 'busy'
  f.loading.value = mode === 'loading'
  f.error.value = mode === 'error' ? 'failed' : ''
  const event = wheel({ ctrlKey: mode !== 'plain' })
  await f.api.on_wheel(event)
  expect(event.preventDefault).not.toHaveBeenCalled()
  expect(f.api.scale.value).toBe(0.5)
})

it('captures one pan pointer, ignores another finger and releases capture on reset', () => {
  const f = setup()
  f.api.on_stage_pointerdown(pointer())
  expect(f.stage.setPointerCapture).toHaveBeenCalledExactlyOnceWith(1)
  f.api.on_stage_pointerdown(pointer({ pointerId: 2 }))
  f.api.on_stage_pointermove(pointer({ pointerId: 2, clientX: 150 }))
  expect(f.stage.scrollLeft).toBe(0)
  f.api.on_stage_pointermove(pointer({ clientX: 150, clientY: 90 }))
  expect([f.stage.scrollLeft, f.stage.scrollTop]).toEqual([- 40, - 20])
  f.api.on_stage_pointerup(pointer({ pointerId: 2 }))
  expect(f.api.pan_state.value).not.toBeNull()
  f.api.space_held.value = true
  f.api.reset()
  expect(f.stage.releasePointerCapture).toHaveBeenCalledExactlyOnceWith(1)
  expect(f.api.pan_state.value).toBeNull()
  expect(f.api.space_held.value).toBe(false)
})

it('keeps brush strokes separate from space/middle-button panning and maps coordinates to image pixels', () => {
  const f = setup()
  f.tool.value = 'brush'
  expect(f.api.is_pan_gesture(pointer())).toBe(false)
  f.api.space_held.value = true
  expect(f.api.is_pan_gesture(pointer())).toBe(true)
  f.api.space_held.value = false
  expect(f.api.is_pan_gesture(pointer({ button: 1 }))).toBe(true)
  expect(f.api.is_pan_gesture(pointer({ ctrlKey: true }))).toBe(true)
  expect(f.api.is_pan_gesture(pointer({ metaKey: true }))).toBe(true)
  expect(f.api.is_pan_gesture(pointer({ pointerType: 'touch', ctrlKey: true }))).toBe(false)
  f.api.on_stage_pointerdown(pointer({ ctrlKey: true }))
  f.api.on_stage_pointermove(pointer({ clientX: 150, clientY: 90 }))
  expect([f.stage.scrollLeft, f.stage.scrollTop]).toEqual([- 40, - 20])
  f.api.on_stage_pointerup(pointer())
  expect(f.api.to_image_point(pointer())).toEqual({ x: 200, y: 100 })
  f.api.update_cursor(pointer())
  expect(f.api.cursor_pos.value).toEqual({ x: 100, y: 50 })
  f.api.update_cursor(pointer({ pointerType: 'touch' }))
  expect(f.api.cursor_pos.value).toBeNull()
})

it('refreshes the hover position after pointer-anchored zoom without a pointermove', async () => {
  const f = setup()
  f.api.fit_to_stage()
  f.api.update_cursor(pointer())
  const zooming = f.api.on_wheel(wheel())
  f.rect.left = - 90
  f.rect.top = - 30
  await zooming
  expect(f.api.cursor_pos.value).toEqual({ x: 200, y: 100 })
})
