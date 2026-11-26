export interface ContentMarkdownSource {
  text: string
  offsets: number[]
}

/** CommonMark normalization with original UTF-16 positions for source edits. */
export function content_markdown_source(text: string, front_matter_end = 0): ContentMarkdownSource {
  const offsets: number[] = []
  let normalized = ''
  for (let index = 0; index < text.length; index ++) {
    offsets.push(index)
    normalized += index < front_matter_end && ! /[\r\n]/.test(text[index]!)
      ? ' '
      : text[index] === '\r' ? '\n' : text[index] === '\0' ? '\uFFFD' : text[index]
    if (text[index] === '\r' && text[index + 1] === '\n')
      index ++
  }
  offsets.push(text.length)
  return { text: normalized, offsets }
}

/** Locate parser content after container prefixes and indentation are removed. */
export function content_markdown_fragment(source: ContentMarkdownSource, text: string, start = 0): ContentMarkdownSource {
  const offsets: number[] = []
  let cursor = start
  let indentation = true
  for (const character of text.split('')) {
    // getLines may expand the remaining width of an indentation tab to spaces.
    if (indentation && character === ' ' && source.text[cursor] !== ' ') {
      offsets.push(source.offsets[cursor]!)
      if (source.text[cursor] === '\t')
        cursor ++
      continue
    }
    cursor = source.text.indexOf(character, cursor)
    if (cursor < 0)
      throw new Error('Cannot locate Markdown source')
    offsets.push(source.offsets[cursor]!)
    cursor ++
    if (character === '\n')
      indentation = true
    else if (character !== ' ' && character !== '\t')
      indentation = false
  }
  offsets.push(source.offsets[cursor] ?? source.offsets.at(- 1)!)
  return { text, offsets }
}

interface ContainerToken {
  content: string
  markup: string
  meta?: { body_start: number, body_end: number, open_length: number } | null
}

/** A container token's source coordinates are relative to its parser input. */
export function content_markdown_token_body(source: ContentMarkdownSource, token: ContainerToken, start = 0) {
  const expected = token.meta ? token.meta.body_start - token.meta.open_length : - 1
  const at = expected >= 0 && source.text.slice(expected, expected + token.markup.length) === token.markup
    ? expected
    : source.text.indexOf(token.markup, start)
  if (at < 0)
    throw new Error('Cannot locate Markdown container source')
  const body_start = at + (token.meta?.open_length ?? token.markup.indexOf('>') + 1)
  const body_end = token.meta ? body_start + token.meta.body_end - token.meta.body_start : body_start + token.content.length
  return {
    start: at, end: at + token.markup.length,
    source: content_markdown_fragment(source, token.content, body_start),
    from: source.offsets[body_start]!, to: source.offsets[body_end]!,
    open_from: source.offsets[at]!, close_to: source.offsets[at + token.markup.length]!,
  }
}
