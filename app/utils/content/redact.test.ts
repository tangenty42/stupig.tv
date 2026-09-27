import type { RedactionStroke } from '~/utils/content/redact'
import { describe, expect, it } from 'vitest'
import { encode_bmp, paint_redaction_stroke, paint_redaction_strokes } from '~/utils/content/redact'

/** Records the drawing calls; the module only touches these members of a 2D context. */
function fake_context() {
  const calls: string[] = []
  const context = {
    fillStyle: '',
    strokeStyle: '',
    lineCap: '',
    lineJoin: '',
    lineWidth: 0,
    save() {
      calls.push('save')
    },
    restore() {
      calls.push('restore')
    },
    beginPath() {
      calls.push('beginPath')
    },
    moveTo(x: number, y: number) {
      calls.push(`moveTo ${x} ${y}`)
    },
    lineTo(x: number, y: number) {
      calls.push(`lineTo ${x} ${y}`)
    },
    arc(x: number, y: number, radius: number) {
      calls.push(`arc ${x} ${y} ${radius}`)
    },
    fill() {
      calls.push(`fill ${String(this.fillStyle)}`)
    },
    stroke() {
      calls.push(`stroke ${String(this.lineWidth)}`)
    },
  }
  return { calls, context: context as unknown as CanvasRenderingContext2D }
}

/** Row-major RGBA pixels, `width` per row. */
function image_data(pixels: number[][], width: number) {
  const data = new Uint8ClampedArray(pixels.length * 4)
  pixels.forEach((pixel, index) => pixel.forEach((channel, offset) => {
    data[index * 4 + offset] = channel!
  }))
  return { data, width, height: pixels.length / width, colorSpace: 'srgb' as const }
}

function stroke(width: number, points: { x: number, y: number }[]): RedactionStroke {
  return { width, points }
}

describe('paint_redaction_stroke', () => {
  it('draws a tap as a filled dot of the brush width', () => {
    const { calls, context } = fake_context()

    paint_redaction_stroke(context, stroke(20, [{ x: 5, y: 6 }]), 0)

    expect(calls).toEqual(['save', 'beginPath', 'arc 5 6 10', 'fill #000000', 'restore'])
  })

  it('lines through every point of a drag', () => {
    const { calls, context } = fake_context()

    paint_redaction_stroke(context, stroke(4, [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 3 }]), 0)

    expect(calls).toEqual([
      'save',
      'beginPath',
      'moveTo 0 0',
      'lineTo 1 1',
      'lineTo 2 3',
      'stroke 4',
      'restore',
    ])
  })

  it('starts from `from`, so an in-flight drag only paints its newest segment', () => {
    const { calls, context } = fake_context()
    const points = [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 3 }]

    paint_redaction_stroke(context, stroke(4, points), points.length - 1)

    expect(calls).toContain('moveTo 2 3')
    expect(calls.filter(call => call.startsWith('lineTo'))).toEqual([])
  })

  it('draws nothing for a stroke with no points', () => {
    const { calls, context } = fake_context()

    paint_redaction_stroke(context, stroke(4, []), 0)

    expect(calls).toEqual([])
  })

  it('paints opaque black, so nothing shows through the redaction', () => {
    const { context } = fake_context()

    paint_redaction_stroke(context, stroke(4, [{ x: 0, y: 0 }, { x: 1, y: 1 }]), 0)

    expect(context.fillStyle).toBe('#000000')
    expect(context.strokeStyle).toBe('#000000')
  })
})

describe('paint_redaction_strokes', () => {
  it('paints every stroke in order', () => {
    const { calls, context } = fake_context()

    paint_redaction_strokes(context, [
      stroke(4, [{ x: 0, y: 0 }, { x: 1, y: 1 }]),
      stroke(4, [{ x: 2, y: 2 }]),
    ])

    expect(calls.filter(call => call.startsWith('stroke'))).toHaveLength(1)
    expect(calls.filter(call => call.startsWith('fill'))).toHaveLength(1)
    expect(calls.indexOf('moveTo 0 0')).toBeLessThan(calls.indexOf('arc 2 2 2'))
  })

  it('paints nothing for an empty drawing', () => {
    const { calls, context } = fake_context()

    paint_redaction_strokes(context, [])

    expect(calls).toEqual(['save', 'restore'])
  })
})

describe('encode_bmp', () => {
  it('writes a 24-bit BMP header and the padded pixel bytes', () => {
    // Three pixels in one row: 9 bytes of pixels, padded to 12.
    const bytes = encode_bmp(image_data([[255, 0, 0, 255], [255, 0, 0, 255], [255, 0, 0, 255]], 3))
    const view = new DataView(bytes.buffer)

    expect(String.fromCharCode(bytes[0]!, bytes[1]!)).toBe('BM')
    expect(view.getUint32(2, true)).toBe(bytes.length)
    expect(view.getUint32(10, true)).toBe(54)
    expect(view.getUint32(14, true)).toBe(40)
    expect(view.getInt32(18, true)).toBe(3)
    expect(view.getInt32(22, true)).toBe(1)
    expect(view.getUint16(26, true)).toBe(1)
    expect(view.getUint16(28, true)).toBe(24)
    expect(bytes.length).toBe(54 + 12)
    expect(view.getUint32(34, true)).toBe(12)
  })

  it('stores the rows bottom-up in BGR order', () => {
    const bytes = encode_bmp(image_data([[255, 0, 0, 255], [0, 0, 255, 255]], 1))

    // A single-pixel row is 3 bytes padded to 4, so the rows start four apart.
    // The last image row comes first, so blue precedes red.
    expect([... bytes.slice(54, 57)]).toEqual([255, 0, 0])
    expect([... bytes.slice(58, 61)]).toEqual([0, 0, 255])
  })

  it('leaves the row padding at zero', () => {
    const bytes = encode_bmp(image_data([[0, 0, 0, 255]], 1))

    expect(bytes.length).toBe(54 + 4)
    expect([... bytes.slice(57, 58)]).toEqual([0])
  })

  it('composites transparency onto white, since 24-bit BMP has no alpha', () => {
    // Half-transparent black would otherwise decode as solid black.
    const bytes = encode_bmp(image_data([[0, 0, 0, 128]], 1))

    expect([... bytes.slice(54, 57)]).toEqual([127, 127, 127])
  })

  it('keeps opaque colours untouched', () => {
    const bytes = encode_bmp(image_data([[18, 52, 86, 255]], 1))

    expect([... bytes.slice(54, 57)]).toEqual([86, 52, 18])
  })
})
