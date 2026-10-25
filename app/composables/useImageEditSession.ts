import type { ImageCrop, ImageEditAction, ImageEditHistory } from '~/utils/content/image-edit'
import { settings } from '@shared/settings'
import { decode_editor_image } from '~/utils/content/image-decode'
import { append_image_edit, assert_editor_size, export_editor_blob, image_edit_has_paint, image_edit_size, normalize_editor_crop, render_image_edits } from '~/utils/content/image-edit'
import { encode_bmp } from '~/utils/content/redact'

interface ImageEditSessionOptions {
  image_canvas: Ref<HTMLCanvasElement | null>
  stroke_canvas: Ref<HTMLCanvasElement | null>
  source_url: () => string | null
  file_name: () => string
  output_mime: () => string
  busy: () => boolean
  cropping: () => boolean
  refit: () => void
  reset_tools: () => void
  on_ready: (bitmap: ImageBitmap) => void
  on_save: (file: File) => void
  on_error: (message: string) => void
}

/**
 * Owns one decoded source, its edit history, renders and asynchronous export.
 * The dialog delegates every close/source-change/unmount to release_source.
 */
export function useImageEditSession(options: ImageEditSessionOptions) {
  const { image_canvas, stroke_canvas } = options
  const limits = settings.app.content.imageEditor
  // Encoded byte size does not bound the memory needed by a decoded bitmap.
  const max_editable_dimension = settings.app.content.redact.maxDimension
  const working = ref(false)
  const loading = ref(false)
  const load_error = ref('')
  const natural_size = ref({ width: 0, height: 0 })
  const source_bitmap = shallowRef<ImageBitmap | null>(null)
  const history = shallowRef<ImageEditHistory>({ actions: [], index: 0 })
  const actions = computed(() => history.value.actions.slice(0, history.value.index))
  const has_paint = computed(() => image_edit_has_paint(actions.value))
  const can_undo = computed(() => history.value.index > 0)
  const can_redo = computed(() => history.value.index < history.value.actions.length)
  let load_generation = 0
  let source_request: AbortController | null = null

  async function load_source() {
    const generation = ++ load_generation
    const source_url = options.source_url()
    if (! source_url) {
      load_error.value = '图片不可读取，无法编辑'
      return
    }
    source_request = new AbortController()
    loading.value = true
    load_error.value = ''
    try {
      const response = await fetch(source_url, { credentials: 'same-origin', cache: 'no-store', signal: source_request.signal })
      if (! response.ok)
        throw new Error('图片读取失败，请刷新后重试')
      const blob = await response.blob()
      const bitmap = await decode_editor_image(blob)
      if (generation !== load_generation) {
        bitmap.close()
        return
      }
      try {
        assert_editor_size(bitmap, max_editable_dimension, limits.maxPixels)
      }
      catch (error) {
        bitmap.close()
        throw error
      }
      source_bitmap.value = bitmap
      natural_size.value = { width: bitmap.width, height: bitmap.height }
      options.on_ready(bitmap)
    }
    catch (error) {
      if (generation !== load_generation)
        return
      load_error.value = error instanceof Error ? error.message : '图片读取失败，请稍后重试'
      return
    }
    finally {
      if (generation === load_generation)
        loading.value = false
    }
    await nextTick()
    if (generation === load_generation)
      await repaint(true)
  }

  async function repaint(refit = false) {
    const source = source_bitmap.value
    if (! source)
      return
    const generation = load_generation
    natural_size.value = image_edit_size(source, actions.value)
    await nextTick()
    if (generation !== load_generation || ! image_canvas.value || ! stroke_canvas.value)
      return
    render_image_edits(source, actions.value, image_canvas.value, stroke_canvas.value)
    if (refit)
      options.refit()
  }

  async function commit_action(action: ImageEditAction) {
    const generation = load_generation
    working.value = true
    try {
      const next = append_image_edit(history.value, action, limits)
      history.value = next
      // The live pointer already painted this stroke. Geometry/clear/history
      // changes need replay; ordinary brush commits do not copy the full bitmap.
      if (action.kind !== 'stroke')
        await repaint(action.kind === 'crop' || action.kind === 'rotate')
    }
    catch (error) {
      if (generation !== load_generation)
        return
      options.on_error(error instanceof Error ? error.message : '无法应用编辑')
      await repaint()
    }
    finally {
      if (generation === load_generation)
        working.value = false
    }
  }

  /** Steps to a history entry and repaints the overlay from it. */
  async function goto_history(index: number) {
    if (options.busy() || options.cropping())
      return
    working.value = true
    const generation = load_generation
    history.value = { ... history.value, index }
    try {
      await repaint(true)
    }
    catch {
      if (generation === load_generation)
        load_error.value = '无法绘制图片，请重新打开编辑器'
    }
    finally {
      if (generation === load_generation)
        working.value = false
    }
  }

  function undo() {
    if (can_undo.value)
      void goto_history(history.value.index - 1)
  }

  function redo() {
    if (can_redo.value)
      void goto_history(history.value.index + 1)
  }

  function clear_strokes() {
    if (options.busy() || ! has_paint.value)
      return
    void commit_action({ kind: 'clear' })
  }

  /** Flattens the source and the strokes into the file the server will store. */
  async function export_file(crop?: ImageCrop) {
    const mime_type = options.output_mime()
    const { width, height } = natural_size.value
    if (! source_bitmap.value || ! image_canvas.value || ! stroke_canvas.value || ! width || ! height)
      throw new Error('无法导出图片')

    const canvas = document.createElement('canvas')
    const rect = normalize_editor_crop(crop ?? { x: 0, y: 0, width, height }, natural_size.value)
    canvas.width = rect.width
    canvas.height = rect.height
    const ctx = canvas.getContext('2d')
    if (! ctx)
      throw new Error('无法导出图片')
    // JPEG and BMP have no alpha channel, and an unpainted JPEG composited by the
    // encoder would go black, so those two flatten onto white first.
    if (mime_type === 'image/jpeg' || mime_type === 'image/bmp') {
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, width, height)
    }
    ctx.drawImage(image_canvas.value, - rect.x, - rect.y)
    ctx.drawImage(stroke_canvas.value, - rect.x, - rect.y)
    try {
      const blob = mime_type === 'image/bmp'
        ? new Blob([encode_bmp(ctx.getImageData(0, 0, rect.width, rect.height))], { type: mime_type })
        : await export_editor_blob(canvas, mime_type)
      return new File([blob], options.file_name(), { type: mime_type })
    }
    finally {
      canvas.width = canvas.height = 0
    }
  }

  async function submit(crop?: ImageCrop) {
    if (options.busy() || loading.value || load_error.value || options.cropping() || ! source_bitmap.value)
      return
    working.value = true
    const generation = load_generation
    try {
      const file = await export_file(crop)
      if (generation === load_generation)
        options.on_save(file)
    }
    catch {
      if (generation === load_generation)
        options.on_error('导出图片失败，请保留编辑并重试')
    }
    finally {
      if (generation === load_generation)
        working.value = false
    }
  }

  function release_source() {
    ++ load_generation
    source_request?.abort()
    source_request = null
    options.reset_tools()
    source_bitmap.value?.close()
    source_bitmap.value = null
    history.value = { actions: [], index: 0 }
    natural_size.value = { width: 0, height: 0 }
    loading.value = false
    working.value = false
    for (const canvas of [image_canvas.value, stroke_canvas.value]) {
      if (canvas)
        canvas.width = canvas.height = 0
    }
  }

  return { working, loading, load_error, natural_size, source_bitmap, history, has_paint, can_undo, can_redo,
    load_source, release_source, repaint, commit_action, undo, redo, clear_strokes, submit,
    get generation() { return load_generation } }
}
