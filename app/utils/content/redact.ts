// Pure helpers behind the 删减版 (redaction) editor: the stroke model it paints
// with, and the BMP encoder browsers' `canvas.toBlob` cannot provide (it only
// speaks PNG, JPEG and WebP). Coordinates and widths are in image pixels, so
// what the overlay shows and what gets exported are the same drawing.

export interface RedactionPoint {
  x: number
  y: number
}

/** One continuous drag: the brush width is captured when it starts. */
export interface RedactionStroke {
  width: number
  points: RedactionPoint[]
}

/** Redaction ink: opaque black, so nothing shows through whatever it covers. */
const redaction_ink = '#000000'

/** Paints every stroke onto a 2D context, replacing what is already there. */
export function paint_redaction_strokes(ctx: CanvasRenderingContext2D, strokes: RedactionStroke[]) {
  ctx.save()
  ctx.fillStyle = redaction_ink
  ctx.strokeStyle = redaction_ink
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  for (const stroke of strokes)
    paint_redaction_stroke(ctx, stroke, 0)
  ctx.restore()
}

/** Paints one stroke; `from` skips the leading segments already on the canvas. */
export function paint_redaction_stroke(ctx: CanvasRenderingContext2D, stroke: RedactionStroke, from: number) {
  const { points, width } = stroke
  if (! points.length)
    return
  ctx.save()
  ctx.fillStyle = redaction_ink
  ctx.strokeStyle = redaction_ink
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.lineWidth = width
  // A tap is a single point: a zero-length path draws nothing, so it becomes a dot.
  if (points.length === 1) {
    const [first] = points
    ctx.beginPath()
    ctx.arc(first!.x, first!.y, width / 2, 0, Math.PI * 2)
    ctx.fill()
    ctx.restore()
    return
  }
  const start = points[from]!
  ctx.beginPath()
  ctx.moveTo(start.x, start.y)
  for (let index = from + 1; index < points.length; index ++) {
    const point = points[index]!
    ctx.lineTo(point.x, point.y)
  }
  ctx.stroke()
  ctx.restore()
}

/** 24-bit BMP, bottom-up rows padded to 4 bytes; alpha is composited onto white. */
export function encode_bmp(image: ImageData) {
  const { width, height, data } = image
  const row_bytes = width * 3
  const padding = (4 - (row_bytes % 4)) % 4
  const pixel_bytes = (row_bytes + padding) * height
  const bytes = new Uint8Array(54 + pixel_bytes)
  const view = new DataView(bytes.buffer)

  bytes[0] = 0x42
  bytes[1] = 0x4D
  view.setUint32(2, bytes.length, true)
  view.setUint32(10, 54, true)
  view.setUint32(14, 40, true)
  view.setInt32(18, width, true)
  view.setInt32(22, height, true)
  view.setUint16(26, 1, true)
  view.setUint16(28, 24, true)
  view.setUint32(34, pixel_bytes, true)
  // 2835 px/m is the convention the format calls 72 DPI.
  view.setUint32(38, 2835, true)
  view.setUint32(42, 2835, true)

  let offset = 54
  for (let y = height - 1; y >= 0; y --) {
    let index = y * width * 4
    for (let x = 0; x < width; x ++) {
      const red = data[index]!
      const green = data[index + 1]!
      const blue = data[index + 2]!
      const alpha = data[index + 3]!
      const blend = (channel: number) => alpha === 255 ? channel : Math.round((channel * alpha + 255 * (255 - alpha)) / 255)
      bytes[offset ++] = blend(blue)
      bytes[offset ++] = blend(green)
      bytes[offset ++] = blend(red)
      index += 4
    }
    offset += padding
  }
  return bytes
}
