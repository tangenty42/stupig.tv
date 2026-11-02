import { html_no_markdown_tags, html_table_tags } from './content-html'
import { create_content_markdown_parser, dedent_html_inner, split_html_wrappers } from './content-markdown-syntax'

// Migration snapshots import content-reference-definitions.ts under its original
// identity. Keep this evolving resolver outside that frozen dependency closure.

interface Source {
  text: string
  offsets: number[]
}

/** Map parser normalization and wrapper indentation back to the original document. */
function fragment(source: Source, text: string, start = 0): Source {
  const offsets: number[] = []
  let cursor = start
  let indentation = true
  for (const char of text.split('')) {
    // getLines can expand the remaining width of a container's indentation
    // tab into spaces. These synthetic spaces have no distinct source byte.
    if (indentation && char === ' ' && source.text[cursor] !== ' ') {
      offsets.push(source.offsets[cursor]!)
      if (source.text[cursor] === '\t')
        cursor ++
      continue
    }
    cursor = source.text.indexOf(char, cursor)
    if (cursor < 0)
      throw new Error('Cannot locate Markdown reference source')
    offsets.push(source.offsets[cursor]!)
    cursor ++
    if (char === '\n')
      indentation = true
    else if (char !== ' ' && char !== '\t')
      indentation = false
  }
  offsets.push(source.offsets[cursor] ?? source.offsets.at(- 1)!)
  return { text, offsets }
}

export interface ReferenceDefinition {
  from: number
  to: number
  /** Parsed URL (entities/escapes resolved); offsets still cover the raw spelling. */
  destination: string
}

/** Resolve live definitions and source regions the preview does not parse as Markdown. */
export function scan_reference_definitions(text: string, front_matter_end = 0) {
  if (! text.includes(']:') && ! text.includes('<'))
    return { definitions: [] as ReferenceDefinition[], ranges: [] as { from: number, to: number }[], resolve: (_label: string): ReferenceDefinition | undefined => undefined }
  // CommonMark normalizes CRLF/CR and NUL before block parsing. Keep original
  // UTF-16 offsets for editor patches, including documents containing emoji.
  const offsets: number[] = []
  let normalized = ''
  for (let i = 0; i < text.length; i ++) {
    offsets.push(i)
    normalized += i < front_matter_end && ! /[\r\n]/.test(text[i]!) ? ' ' : text[i] === '\r' ? '\n' : text[i] === '\0' ? '\uFFFD' : text[i]
    if (text[i] === '\r' && text[i + 1] === '\n')
      i ++
  }
  offsets.push(text.length)
  let source: Source = { text: normalized, offsets }
  const definitions = new Map<string, ReferenceDefinition>()
  const used = new Set<string>()
  const ranges: { from: number, to: number }[] = []
  let in_definition = false
  let inline_reads: string[] | undefined
  const references: Record<string, { href: string, title: string }> = Object.create(null)
  const env = { references: new Proxy(references, {
    get(target, key: string) {
      if (! in_definition && Object.hasOwn(target, key))
        inline_reads?.push(key)
      return target[key]
    },
  }) }
  const md = create_content_markdown_parser()
  // Label lookahead also resolves references in silent mode. Count only an
  // accepted, emitted link/image, not speculative reads that were rolled back.
  for (const name of ['link', 'image']) {
    const rules = md.inline.ruler.getRules('')
    md.inline.ruler.disable(name)
    const remaining = md.inline.ruler.getRules('')
    const original = rules.find(rule => ! remaining.includes(rule))!
    md.inline.ruler.enable(name)
    md.inline.ruler.at(name, (state, silent) => {
      const previous = inline_reads
      const reads: string[] = []
      inline_reads = reads
      try {
        const accepted = original(state, silent)
        if (accepted && ! silent)
          reads.forEach(label => used.add(label))
        return accepted
      }
      finally { inline_reads = previous }
    })
  }
  // Retrieve the named rule through the public ruler API, without depending
  // on function names (minified in production) or importing package internals.
  const rules = md.block.ruler.getRules('')
  md.block.ruler.disable('reference')
  const remaining = md.block.ruler.getRules('')
  const reference = rules.find(rule => ! remaining.includes(rule))!
  md.block.ruler.enable('reference')
  const parse_destination = md.helpers.parseLinkDestination
  const captures: { text: string, from: number, to: number }[] = []
  md.helpers.parseLinkDestination = (input, pos, max) => {
    const result = parse_destination(input, pos, max)
    if (in_definition && result.ok)
      captures.push({ text: input, from: pos, to: result.pos })
    return result
  }
  md.block.ruler.at('reference', (state, start, end, silent) => {
    const previous = in_definition
    in_definition = true
    captures.length = 0
    try {
      const accepted = reference(state, start, end, silent)
      const captured = captures.at(- 1)
      if (! accepted || silent || ! captured)
        return accepted
      const label_end = captured.text.lastIndexOf(']:', captured.from)
      const label = md.utils.normalizeReference(captured.text.slice(1, label_end))
      const locate = (pos: number) => {
        const prefix = captured.text.slice(0, pos)
        const line = start + prefix.split('\n').length - 1
        return state.bMarks[line]! + state.tShift[line]! + pos - (prefix.lastIndexOf('\n') + 1)
      }
      const wrapped = captured.text[captured.from] === '<'
      const from = locate(captured.from + (wrapped ? 1 : 0))
      const to = locate(captured.to - (wrapped ? 1 : 0))
      if (! definitions.has(label))
        definitions.set(label, { from: source.offsets[from]!, to: source.offsets[to]!, destination: references[label]!.href })
      // Also exclude unused and shadowed definitions from the inline scanner.
      ranges.push({ from: source.offsets[state.bMarks[start]! + state.tShift[start]!]!, to: source.offsets[state.bMarks[state.line]!] ?? source.offsets.at(- 1)! })
      return true
    }
    finally { in_definition = previous }
  })
  const parse = (current: Source) => {
    source = current
    const tokens = md.parse(current.text, env)
    const starts = [0]
    for (let i = 0; i < current.text.length; i ++) {
      if (current.text[i] === '\n')
        starts.push(i + 1)
    }
    for (const token of tokens) {
      if (token.type !== 'html_block' || ! token.map)
        continue
      const block = fragment(current, token.content, starts[token.map[0]])
      const chunks = split_html_wrappers(token.content)
      if (! chunks) {
        ranges.push({ from: block.offsets[0]!, to: block.offsets.at(- 1)! })
        continue
      }
      let cursor = 0
      for (const chunk of chunks) {
        const start = block.text.indexOf(chunk.source, cursor)
        cursor = start + chunk.source.length
        if (! chunk.closed || html_no_markdown_tags.has(chunk.tag) || html_table_tags.has(chunk.tag)) {
          ranges.push({ from: block.offsets[start]!, to: block.offsets[cursor]! })
          continue
        }
        if (! chunk.inner)
          continue
        const inner = fragment(block, chunk.inner, start + chunk.source.indexOf('>') + 1)
        parse(fragment(inner, dedent_html_inner(chunk.inner)))
      }
    }
  }
  parse(source)
  return { definitions: [... definitions].filter(([label]) => used.has(label)).map(([, definition]) => definition), ranges: ranges.sort((a, b) => a.from - b.from),
    resolve: (label: string) => {
      const key = md.utils.normalizeReference(label)
      return used.has(key) ? definitions.get(key) : undefined
    } }
}
