import type { ImageEditAction } from './image-edit'
import { attachment_path_violation } from '@shared/content-markdown'
import { describe, expect, it, vi } from 'vitest'
import { append_image_edit, assert_editor_size, export_editor_blob, image_edit_has_paint, image_edit_size, normalize_editor_crop, suggested_image_name } from './image-edit'

const limits = { maxPixels: 100, maxActions: 5, maxStrokePoints: 3 }
const stroke: ImageEditAction = { kind: 'stroke', stroke: { width: 2, points: [{ x: 4, y: 3 }] } }

describe('image edit operations', () => {
  it('suggests names accepted by upload admission without reserved whitespace', () => {
    expect(suggested_image_name('folder/photo.PNG.good', 'copy')).toBe('photo_副本.avif')
    expect(suggested_image_name('folder/photo.PNG.good', 'redacted')).toBe('photo_删减版.avif')
    expect(attachment_path_violation(suggested_image_name('photo.png', 'copy'))).toBeNull()
  })
  it('keeps geometry across brush and clear operations', () => {
    const actions: ImageEditAction[] = [stroke, { kind: 'rotate', direction: 1 }, { kind: 'crop', rect: { x: 2, y: 1, width: 4, height: 6 } }, { kind: 'clear' }]
    expect(image_edit_size({ width: 10, height: 8 }, actions)).toEqual({ width: 4, height: 6 })
    expect(image_edit_has_paint(actions.slice(0, 3))).toBe(true)
    expect(image_edit_has_paint(actions)).toBe(false)
    expect(image_edit_has_paint([... actions, stroke])).toBe(true)
  })

  it('reads dimensions from DOM-style prototype accessors', () => {
    class BitmapSize {
      get width() { return 10 }
      get height() { return 8 }
    }
    expect(image_edit_size(new BitmapSize(), [])).toEqual({ width: 10, height: 8 })
    expect(image_edit_size(new BitmapSize(), [{ kind: 'rotate', direction: 1 }])).toEqual({ width: 8, height: 10 })
  })

  it('truncates redo only after a new operation and owns committed stroke points', () => {
    const live = structuredClone(stroke)
    const first = append_image_edit({ actions: [], index: 0 }, live, limits)
    const second = append_image_edit(first, { kind: 'rotate', direction: 1 }, limits)
    const branched = append_image_edit({ ... second, index: 1 }, { kind: 'clear' }, limits)
    expect(branched.actions.map(action => action.kind)).toEqual(['stroke', 'clear'])
    expect(second.actions.map(action => action.kind)).toEqual(['stroke', 'rotate'])
    if (live.kind === 'stroke')
      live.stroke.points[0]!.x = 100
    expect(first.actions[0]).toEqual(stroke)
  })

  it('clamps rounding at crop edges and rejects empty or nonfinite crops', () => {
    expect(normalize_editor_crop({ x: - 0.4, y: 1.2, width: 10.8, height: 6.8 }, { width: 10, height: 8 })).toEqual({ x: 0, y: 1, width: 10, height: 7 })
    for (const rect of [{ x: 20, y: 0, width: 1, height: 1 }, { x: 0, y: 0, width: 0, height: 1 }, { x: Number.NaN, y: 0, width: 1, height: 1 }])
      expect(() => normalize_editor_crop(rect, { width: 10, height: 8 })).toThrow('裁剪区域无效')
  })

  it('rejects excessive dimensions, pixel count and invalid dimensions', () => {
    expect(() => assert_editor_size({ width: 10, height: 10 }, 10, 100)).not.toThrow()
    for (const size of [{ width: 11, height: 1 }, { width: 0, height: 2 }, { width: 1.5, height: 2 }, { width: Number.NaN, height: 2 }])
      expect(() => assert_editor_size(size, 10, 100)).toThrow('图片尺寸')
    expect(() => assert_editor_size({ width: 10, height: 10 }, 10, 99)).toThrow('图片尺寸')
  })

  it('bounds history and total points, including a new stroke', () => {
    expect(() => append_image_edit({ actions: [stroke, stroke, stroke, stroke, stroke], index: 5 }, { kind: 'clear' }, limits)).toThrow('编辑步骤过多')
    expect(() => append_image_edit({ actions: [stroke, stroke, stroke], index: 3 }, stroke, limits)).toThrow('笔迹过多')
    expect(() => append_image_edit({ actions: [], index: 0 }, { kind: 'stroke', stroke: { width: 0, points: [] } }, limits)).toThrow('笔迹数据无效')
  })

  it('checks actual export MIME, empty results and encoder failure', async () => {
    const toBlob = vi.fn()
    const canvas = { toBlob } as unknown as HTMLCanvasElement
    const png = new Blob(['png'], { type: 'image/png' })
    toBlob.mockImplementationOnce(callback => callback(png))
    expect(await export_editor_blob(canvas, 'image/png')).toBe(png)
    toBlob.mockImplementationOnce(callback => callback(png))
    await expect(export_editor_blob(canvas, 'image/avif')).rejects.toThrow('无法导出指定图片格式')
    toBlob.mockImplementationOnce(callback => callback(null))
    await expect(export_editor_blob(canvas, 'image/png')).rejects.toThrow('无法导出指定图片格式')
    toBlob.mockImplementationOnce(callback => callback(new Blob([], { type: 'image/png' })))
    await expect(export_editor_blob(canvas, 'image/png')).rejects.toThrow('无法导出指定图片格式')
    toBlob.mockImplementationOnce(() => {
      throw new DOMException('Tainted canvas', 'SecurityError')
    })
    await expect(export_editor_blob(canvas, 'image/png')).rejects.toThrow('Tainted canvas')
  })
})
