import type { Diagnostic } from '@codemirror/lint'
import type { Text } from '@codemirror/state'
import { html_no_markdown_tags, html_table_tags } from '@shared/content-html'
import { create_content_markdown_parser, dedent_html_inner, split_html_wrappers } from '@shared/content-markdown-syntax'

export const outer_refs_source = 'outer-refs'

/** Diagnose link uses at their source line, including resolved reference links. */
export function iframe_link_diagnostics(source: string, doc: Text): Diagnostic[] {
  const md = create_content_markdown_parser()
  const rules = md.inline.ruler.getRules('')
  md.inline.ruler.disable('link')
  const remaining = md.inline.ruler.getRules('')
  const link_rule = rules.find(rule => ! remaining.includes(rule))!
  md.inline.ruler.enable('link')
  md.inline.ruler.at('link', (state, silent) => {
    const position = state.pos
    const index = state.tokens.length
    const accepted = link_rule(state, silent)
    if (accepted && ! silent && state.tokens[index]?.type === 'link_open') {
      const token = state.tokens[index]!
      token.meta = { ... token.meta, source_line_offset: state.src.slice(0, position).split('\n').length - 1 }
    }
    return accepted
  })
  const diagnostics: Diagnostic[] = []
  const env = {}
  const scan = (markdown: string, line_offset: number) => {
    for (const block of md.parse(markdown, env)) {
      if (! block.map)
        continue
      if (block.type === 'html_block') {
        const chunks = split_html_wrappers(block.content)
        let cursor = 0
        for (const chunk of chunks ?? []) {
          const start = block.content.indexOf(chunk.source, cursor)
          cursor = start + chunk.source.length
          if (! chunk.closed || html_no_markdown_tags.has(chunk.tag) || html_table_tags.has(chunk.tag))
            continue
          const before_inner = chunk.source.indexOf('>') + 1
          const leading = chunk.inner.length - chunk.inner.trimStart().length
          const prefix = block.content.slice(0, start + before_inner + leading)
          scan(dedent_html_inner(chunk.inner), line_offset + block.map[0] + prefix.split('\n').length - 1)
        }
      }
      if (block.type !== 'inline')
        continue
      for (const token of block.children ?? []) {
        if (token.type !== 'link_open' || ! token.attrGet('href')?.startsWith('iframe://'))
          continue
        const line_number = Math.min(line_offset + block.map[0] + 1 + (token.meta?.source_line_offset ?? 0), doc.lines)
        const line = doc.line(line_number)
        diagnostics.push({ from: line.from, to: line.to, severity: 'warning', source: outer_refs_source, message: 'iframe:// 只能用于图片语法 ![标题](iframe://...)' })
      }
    }
  }
  scan(source, 0)
  return diagnostics
}
