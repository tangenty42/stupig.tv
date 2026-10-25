import { afterEach, describe, expect, it, vi } from 'vitest'
import { decode_editor_image, ImageEditorDecodeError } from './image-decode'

afterEach(() => vi.unstubAllGlobals())

describe('editor native decoding fence', () => {
  it('blocks browsers without the required decoder', async () => {
    vi.stubGlobal('createImageBitmap', undefined)
    await expect(decode_editor_image(new Blob())).rejects.toThrow('请升级或更换浏览器')
  })

  it('decodes the actual AVIF source rather than substituting a JPEG', async () => {
    const source = new Blob(['avif sample'], { type: 'image/avif' })
    const bitmap = { width: 2, height: 2 }
    const decode = vi.fn().mockResolvedValue(bitmap)
    vi.stubGlobal('createImageBitmap', decode)
    expect(await decode_editor_image(source)).toBe(bitmap)
    expect(decode).toHaveBeenCalledExactlyOnceWith(source, { imageOrientation: 'from-image' })
  })

  it('blocks a failed actual decode even when the API exists', async () => {
    const decode = vi.fn().mockRejectedValue(new DOMException('Unsupported image'))
    vi.stubGlobal('createImageBitmap', decode)
    await expect(decode_editor_image(new Blob(['avif'], { type: 'image/avif' }))).rejects.toBeInstanceOf(ImageEditorDecodeError)
    expect(decode).toHaveBeenCalledTimes(1)
  })
})
