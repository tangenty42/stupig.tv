/** Read dimensions without decoding pixels, hashing or copying the whole file. */
export async function image_upload_size(file: Blob) {
  const read = async (offset: number, size: number) => {
    const data = new DataView(await file.slice(offset, offset + size).arrayBuffer())
    if (data.byteLength !== size)
      throw new Error('图片头不完整，请检查文件')
    return data
  }
  const text = (data: DataView, offset: number, length: number) => String.fromCharCode(... new Uint8Array(data.buffer, offset, length))
  const head = await read(0, Math.min(file.size, 32))
  if (head.byteLength >= 24 && head.getUint32(0) === 0x89504E47 && head.getUint32(4) === 0x0D0A1A0A && text(head, 12, 4) === 'IHDR')
    return { width: head.getUint32(16), height: head.getUint32(20) }
  if (head.byteLength >= 12 && head.getUint16(0) === 0xFFD8) {
    let offset = 2
    for (let segments = 0; segments < 1024 && offset + 4 <= file.size; segments ++) {
      const marker = await read(offset, 4)
      if (marker.getUint8(0) !== 0xFF)
        break
      const code = marker.getUint8(1)
      if (code === 0xFF) {
        offset ++
        continue
      }
      if (code === 0xDA || code === 0xD9)
        break
      if (code === 0x01 || code === 0xD8 || (code >= 0xD0 && code <= 0xD7)) {
        offset += 2
        continue
      }
      const length = marker.getUint16(2)
      if (length < 2 || offset + 2 + length > file.size)
        break
      if ([0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF].includes(code) && length >= 7) {
        const size = await read(offset + 5, 4)
        return { width: size.getUint16(2), height: size.getUint16(0) }
      }
      offset += 2 + length
    }
  }
  if (head.byteLength >= 25 && text(head, 0, 4) === 'RIFF' && text(head, 8, 4) === 'WEBP') {
    const type = text(head, 12, 4)
    const u24 = (offset: number) => head.getUint8(offset) + (head.getUint8(offset + 1) << 8) + (head.getUint8(offset + 2) << 16)
    if (type === 'VP8X' && head.byteLength >= 30)
      return { width: u24(24) + 1, height: u24(27) + 1 }
    if (type === 'VP8 ' && head.byteLength >= 30 && head.getUint8(23) === 0x9D && head.getUint8(24) === 1 && head.getUint8(25) === 0x2A)
      return { width: head.getUint16(26, true) & 0x3FFF, height: head.getUint16(28, true) & 0x3FFF }
    if (type === 'VP8L' && head.getUint8(20) === 0x2F) {
      const bits = head.getUint32(21, true)
      return { width: (bits & 0x3FFF) + 1, height: ((bits >>> 14) & 0x3FFF) + 1 }
    }
  }
  if (head.byteLength >= 16 && text(head, 4, 4) === 'ftyp') {
    let visited = 0
    const sizes: { width: number, height: number }[] = []
    const walk = async (start: number, end: number, depth: number) => {
      if (depth > 4)
        return
      for (let offset = start; offset + 8 <= end;) {
        if (++ visited > 512)
          throw new Error('图片头过于复杂，请重新导出图片')
        const box = await read(offset, 8)
        let length = box.getUint32(0)
        let header = 8
        if (length === 1) {
          const extended = await read(offset + 8, 8)
          length = extended.getUint32(0) * 2 ** 32 + extended.getUint32(4)
          header = 16
        }
        if (length === 0)
          length = end - offset
        if (! Number.isSafeInteger(length) || length < header || offset + length > end)
          throw new Error('图片容器无效，请检查文件')
        const type = text(box, 4, 4)
        if (type === 'ispe' && length >= header + 12) {
          const dimensions = await read(offset + header + 4, 8)
          sizes.push({ width: dimensions.getUint32(0), height: dimensions.getUint32(4) })
        }
        if (['meta', 'iprp', 'ipco'].includes(type))
          await walk(offset + header + (type === 'meta' ? 4 : 0), offset + length, depth + 1)
        offset += length
      }
    }
    await walk(0, file.size, 0)
    if (sizes.length)
      return { width: Math.max(... sizes.map(size => size.width)), height: Math.max(... sizes.map(size => size.height)) }
  }
  throw new Error('无法读取图片尺寸，请重新导出为 JPEG、PNG、WebP 或 AVIF 后重试')
}
