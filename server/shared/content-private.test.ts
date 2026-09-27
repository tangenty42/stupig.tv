import { describe, expect, it } from 'vitest'
import { CONTENT_PRIVATE_BLOCK_PLACEHOLDER, CONTENT_PRIVATE_INLINE_PLACEHOLDER, has_private_content, redact_private_content } from './content-private'

const B = CONTENT_PRIVATE_BLOCK_PLACEHOLDER
const I = CONTENT_PRIVATE_INLINE_PLACEHOLDER

describe('has_private_content', () => {
  it('is false for plain markdown', () => {
    expect(has_private_content('hello\n\nworld **bold**\n')).toBe(false)
  })

  it('is true for a block private element', () => {
    expect(has_private_content('a\n\n<good>\nx\n</good>\n\nb\n')).toBe(true)
  })

  it('is true for a one-line block private element', () => {
    expect(has_private_content('a\n\n<good>x</good>\n\nb\n')).toBe(true)
  })

  it('is true for an inline private element', () => {
    expect(has_private_content('before <good>x</good> after\n')).toBe(true)
  })

  it('ignores lookalikes inside code spans and fenced blocks', () => {
    expect(has_private_content('`<good>x</good>`\n')).toBe(false)
    expect(has_private_content('```\n<good>x</good>\n```\n')).toBe(false)
  })

  it('is false for an unclosed private element', () => {
    // The tokenizer only claims matched open/close pairs; an unclosed tag
    // falls back to plain text (and the linter blocks saving it anyway).
    expect(has_private_content('a\n\n<good>\nx\n')).toBe(false)
    expect(has_private_content('before <good>x\n')).toBe(false)
  })
})

describe('redact_private_content', () => {
  it('returns markdown without private content unchanged', () => {
    const doc = 'hello\n\nworld **bold**\n'
    expect(redact_private_content(doc)).toBe(doc)
  })

  it('replaces a block element with the block placeholder', () => {
    expect(redact_private_content('a\n\n<good>\nsecret **bold**\n</good>\n\nb\n'))
      .toBe(`a\n\n${B}\n\nb\n`)
  })

  it('replaces a one-line block element', () => {
    expect(redact_private_content('a\n\n<good>secret</good>\n\nb\n'))
      .toBe(`a\n\n${B}\n\nb\n`)
  })

  it('replaces an inline element and keeps the surrounding text', () => {
    expect(redact_private_content('before <good>secret</good> after\n'))
      .toBe(`before ${I} after\n`)
  })

  it('treats a whole-line single-line element as a block', () => {
    expect(redact_private_content('<good>a</good>\n'))
      .toBe(`${B}\n`)
  })

  it('treats a line-start element with trailing content as inline', () => {
    expect(redact_private_content('<good>a</good> mid <good>b</good> end\n'))
      .toBe(`${I} mid ${I} end\n`)
  })

  it('replaces every inline element mid-line', () => {
    expect(redact_private_content('x <good>a</good> mid <good>b</good> end\n'))
      .toBe(`x ${I} mid ${I} end\n`)
  })

  it('replaces nested private elements as one outer range', () => {
    expect(redact_private_content('<good>\nouter\n\n<good>\ninner\n</good>\n\n</good>\n\nafter\n'))
      .toBe(`${B}\n\nafter\n`)
  })

  it('leaves trailing text after the close tag outside the placeholder', () => {
    // Only the element's children are private; text trailing the close tag is
    // ordinary content and survives on the next line.
    expect(redact_private_content('<good>\nx\n</good> tail text\n\nafter\n'))
      .toBe(`${B}\n tail text\n\nafter\n`)
  })

  it('leaves code spans and fenced blocks untouched', () => {
    expect(redact_private_content('`<good>x</good>` and <good>y</good>\n'))
      .toBe(`\`<good>x</good>\` and ${I}\n`)
    expect(redact_private_content('```\n<good>x</good>\n```\n'))
      .toBe('```\n<good>x</good>\n```\n')
  })

  it('leaves an unclosed element intact rather than guessing its extent', () => {
    const doc = 'a\n\n<good>\nsecret\n'
    expect(redact_private_content(doc)).toBe(doc)
  })

  it('replaces private elements inside html wrappers', () => {
    expect(redact_private_content('<center>\n<good>x</good>\n</center>\n'))
      .toBe(`<center>\n${I}\n</center>\n`)
  })

  it('is idempotent', () => {
    const doc = 'a\n\n<good>\nx\n</good>\n\nb <good>y</good> c\n'
    expect(redact_private_content(redact_private_content(doc))).toBe(redact_private_content(doc))
  })

  it('never leaves a private marker or private source behind', () => {
    const doc = 'a\n\n<good>\nsecret x\n</good>\n\nb <good>secret y</good> c\n'
    expect(has_private_content(doc)).toBe(true)
    const redacted = redact_private_content(doc)
    expect(redacted).not.toContain('good')
    expect(redacted).not.toContain('secret')
  })
})

describe('private elements nested in links and image captions', () => {
  it('has_private_content sees a private element inside an image caption', () => {
    expect(has_private_content('![before <good>secret</good> after](x.png)\n')).toBe(true)
  })

  it('has_private_content sees a private element inside a link label', () => {
    expect(has_private_content('[a <good>secret</good> b](https://example.com)\n')).toBe(true)
  })

  it('redacts a private element inside an image caption', () => {
    const redacted = redact_private_content('![before <good>secret</good> after](x.png)\n')

    expect(redacted).toBe(`![before ${CONTENT_PRIVATE_INLINE_PLACEHOLDER} after](x.png)\n`)
    expect(redacted).not.toContain('secret')
  })

  it('redacts a private element inside a link label', () => {
    const redacted = redact_private_content('[a <good>secret</good> b](https://example.com)\n')

    expect(redacted).toContain(CONTENT_PRIVATE_INLINE_PLACEHOLDER)
    expect(redacted).not.toContain('secret')
  })
})
