/** Expected editor failure; transport errors are handled separately by callers. */
export class ImageEditorDecodeError extends Error {}

/** Decode the actual editing source, without substituting a display fallback. */
export async function decode_editor_image(blob: Blob) {
  if (typeof globalThis.createImageBitmap !== 'function')
    throw new ImageEditorDecodeError('当前浏览器不支持图片编辑所需的解码能力，请升级或更换浏览器')

  try {
    return await globalThis.createImageBitmap(blob, { imageOrientation: 'from-image' })
  }
  catch {
    // A failed decode can also mean a corrupt/unsupported input, not just an
    // outdated browser. Do not misreport network or permission errors here.
    throw new ImageEditorDecodeError('当前浏览器无法解码这张图片，无法继续编辑；请尝试更新浏览器，若仍失败请检查图片文件')
  }
}
