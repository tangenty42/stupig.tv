import type { RedactionStroke } from './redact'
import { attachment_base_name, decrypted_attachment_name, sanitize_attachment_path } from '@shared/content-markdown'
import { settings } from '@shared/settings'
import { paint_redaction_stroke } from './redact'

export function suggested_image_name(file_name: string, mode: 'copy' | 'redacted') {
  const stem = attachment_base_name(decrypted_attachment_name(file_name)).replace(/\.[^.]+$/, '')
  return sanitize_attachment_path(`${stem}_${mode === 'redacted' ? '删减版' : '副本'}.avif`, settings.app.content.link.fileNameMaxBytes)
}

export interface ImageSize { width: number, height: number }
export interface ImageCrop extends ImageSize { x: number, y: number }
export type ImageEditAction
  = | { kind: 'stroke', stroke: RedactionStroke }
    | { kind: 'clear' }
    | { kind: 'crop', rect: ImageCrop }
    | { kind: 'rotate', direction: 1 | - 1 }
export interface ImageEditHistory { actions: ImageEditAction[], index: number }
export interface ImageEditLimits { maxPixels: number, maxActions: number, maxStrokePoints: number }

export function assert_editor_size(size: ImageSize, max_dimension: number, max_pixels: number) {
  if (! Number.isSafeInteger(size.width) || ! Number.isSafeInteger(size.height) || size.width <= 0 || size.height <= 0
    || size.width > max_dimension || size.height > max_dimension || size.width * size.height > max_pixels) {
    throw new Error('图片尺寸过大或无效，无法在浏览器中编辑')
  }
}

/** Cropper coordinates may be fractional or touch an edge; always stay inside. */
export function normalize_editor_crop(rect: ImageCrop, size: ImageSize): ImageCrop {
  if (! [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) || rect.width <= 0 || rect.height <= 0)
    throw new Error('裁剪区域无效')
  const x = Math.max(0, Math.round(rect.x))
  const y = Math.max(0, Math.round(rect.y))
  const right = Math.min(size.width, Math.round(rect.x + rect.width))
  const bottom = Math.min(size.height, Math.round(rect.y + rect.height))
  if (right <= x || bottom <= y)
    throw new Error('裁剪区域无效')
  return { x, y, width: right - x, height: bottom - y }
}

export function image_edit_size(source: ImageSize, actions: readonly ImageEditAction[]) {
  // DOM bitmap/canvas dimensions are prototype accessors, not enumerable fields.
  let size = { width: source.width, height: source.height }
  for (const action of actions) {
    if (action.kind === 'rotate')
      size = { width: size.height, height: size.width }
    if (action.kind === 'crop') {
      const rect = normalize_editor_crop(action.rect, size)
      size = { width: rect.width, height: rect.height }
    }
  }
  return size
}

export function append_image_edit(history: ImageEditHistory, action: ImageEditAction, limits: ImageEditLimits): ImageEditHistory {
  const actions = history.actions.slice(0, history.index)
  if (actions.length >= limits.maxActions)
    throw new Error('编辑步骤过多，请先保存再继续编辑')
  const points = actions.reduce((total, item) => total + (item.kind === 'stroke' ? item.stroke.points.length : 0), 0)
  if (action.kind === 'stroke') {
    if (! Number.isFinite(action.stroke.width) || action.stroke.width <= 0 || ! action.stroke.points.length
      || action.stroke.points.some(point => ! Number.isFinite(point.x) || ! Number.isFinite(point.y))) {
      throw new Error('笔迹数据无效')
    }
    if (points + action.stroke.points.length > limits.maxStrokePoints)
      throw new Error('笔迹过多，请先保存再继续编辑')
  }
  // Own the points; a pointer continuing to move cannot mutate committed history.
  actions.push(action.kind === 'stroke'
    ? { kind: 'stroke', stroke: { width: action.stroke.width, points: action.stroke.points.map(point => ({ ... point })) } }
    : action.kind === 'crop' ? { kind: 'crop', rect: { ... action.rect } } : { ... action })
  return { actions, index: actions.length }
}

export function image_edit_has_paint(actions: readonly ImageEditAction[]) {
  let painted = false
  for (const action of actions) {
    if (action.kind === 'stroke')
      painted = true
    if (action.kind === 'clear')
      painted = false
  }
  return painted
}

function context(canvas: HTMLCanvasElement) {
  const ctx = canvas.getContext('2d')
  if (! ctx)
    throw new Error('当前浏览器无法创建图片画布')
  return ctx
}

/** Replays geometry on both layers; clearing paint never restores cropped pixels. */
export function render_image_edits(source: ImageBitmap, actions: readonly ImageEditAction[], image: HTMLCanvasElement, ink: HTMLCanvasElement) {
  image.width = ink.width = source.width
  image.height = ink.height = source.height
  context(image).drawImage(source, 0, 0)
  const scratch = document.createElement('canvas')
  try {
    for (const action of actions) {
      if (action.kind === 'stroke') {
        paint_redaction_stroke(context(ink), action.stroke, 0)
      }
      else if (action.kind === 'clear') {
        context(ink).clearRect(0, 0, ink.width, ink.height)
      }
      else {
        const size = image_edit_size(image, [action])
        for (const layer of [image, ink]) {
          scratch.width = size.width
          scratch.height = size.height
          const ctx = context(scratch)
          if (action.kind === 'crop') {
            const rect = normalize_editor_crop(action.rect, layer)
            ctx.drawImage(layer, rect.x, rect.y, rect.width, rect.height, 0, 0, size.width, size.height)
          }
          else {
            ctx.translate(action.direction === 1 ? layer.height : 0, action.direction === - 1 ? layer.width : 0)
            ctx.rotate(action.direction * Math.PI / 2)
            ctx.drawImage(layer, 0, 0)
          }
          layer.width = size.width
          layer.height = size.height
          context(layer).drawImage(scratch, 0, 0)
        }
      }
    }
  }
  finally {
    scratch.width = scratch.height = 0
  }
}

/** toBlob silently falls back to PNG for unsupported types; never mislabel it. */
export async function export_editor_blob(canvas: HTMLCanvasElement, mime: string) {
  const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, mime))
  if (! blob?.size || blob.type !== mime)
    throw new Error('当前浏览器无法导出指定图片格式，请升级或更换浏览器')
  return blob
}
