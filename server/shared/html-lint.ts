// Grammar-check the HTML blocks/tags in a markdown document with the lezer
// HTML parser, reporting malformed open tags (unclosed quote / missing `>`),
// mismatched close tags, and elements missing their close tag. Only tag
// structure is checked — text content (markdown) is never treated as HTML.
//
// Shared between the editor (live lint) and the server (save validation) so
// both agree on what counts as broken HTML.
import { htmlLanguage } from '@codemirror/lang-html'
import { markdownLanguage } from '@codemirror/lang-markdown'

export interface HtmlLintDiagnostic {
  /** Absolute offset in the document. */
  from: number
  /** Exclusive end offset in the document. */
  to: number
  severity: 'error'
  message: string
  source: 'html'
}

// True when the HTML parse of `region_text` still has an element open: an
// open tag with a proper `>` but no matching close tag yet. Used to group
// adjacent HTML nodes, so a wrapper split by a blank line (`<center>` ...
// `</center>`) — or nested content like `<ul><li>...</li>` — stays in one
// region until its close tag arrives.
function html_region_has_unclosed(region_text: string) {
  const tree = htmlLanguage.parser.parse(region_text)
  let unclosed = false
  tree.iterate({ enter: (n) => {
    if (n.type.name === 'Element') {
      const open = n.node.getChild('OpenTag')
      const close = n.node.getChild('CloseTag')
      if (open && open.getChild('EndTag') && ! close) {
        unclosed = true
      }
    }
  } })
  return unclosed
}

export function build_html_diagnostics(doc_text: string): HtmlLintDiagnostic[] {
  const diagnostics: HtmlLintDiagnostic[] = []
  const tree = markdownLanguage.parser.parse(doc_text)
  const html_nodes: { from: number, to: number }[] = []
  tree.iterate({ enter: (n) => {
    if (n.type.name === 'HTMLBlock' || n.type.name === 'HTMLTag') {
      html_nodes.push({ from: n.from, to: n.to })
    }
  } })
  if (! html_nodes.length) {
    return diagnostics
  }

  // Group adjacent HTML nodes into regions: keep absorbing nodes while the
  // accumulated text still has unclosed elements, so a wrapper split by a
  // blank line rejoins into a single region before linting.
  const regions: { from: number, to: number }[][] = []
  let current: { from: number, to: number }[] = []
  for (let i = 0; i < html_nodes.length; i ++) {
    current.push(html_nodes[i]!)
    const region_text = current.map(n => doc_text.slice(n.from, n.to)).join('\n')
    if (! html_region_has_unclosed(region_text) || i === html_nodes.length - 1) {
      regions.push(current)
      current = []
    }
  }

  for (const region_nodes of regions) {
    // Concatenate the node texts and remember each region offset's doc offset,
    // so diagnostics found in the region can be mapped back to the document.
    const parts: string[] = []
    const map: number[] = []
    for (let i = 0; i < region_nodes.length; i ++) {
      const node = region_nodes[i]!
      if (i > 0) {
        parts.push('\n')
        map.push(- 1)
      }
      for (let p = node.from; p < node.to; p ++) {
        parts.push(doc_text[p]!)
        map.push(p)
      }
    }
    const region_text = parts.join('')
    const to_doc = (region_from: number, region_to: number) => {
      const from = map[region_from] ?? - 1
      const to = region_to > region_from ? (map[region_to - 1] ?? - 1) + 1 : from + 1
      return { from, to }
    }

    const ht = htmlLanguage.parser.parse(region_text)
    ht.iterate({ enter: (n) => {
      const name = n.type.name
      if (name === 'OpenTag' && ! n.node.getChild('EndTag')) {
        // Unclosed open tag: a missing `>` or an unterminated attribute quote.
        const tag = n.node.getChild('TagName')
        const { from, to } = to_doc(tag?.from ?? n.from, tag?.to ?? n.to)
        if (from >= 0) {
          diagnostics.push({
            from,
            to: Math.max(to, from + 1),
            severity: 'error',
            message: 'HTML 标签未正确闭合（属性引号或 > 缺失）',
            source: 'html',
          })
        }
      }
      else if (name === 'MismatchedCloseTag') {
        const parent_tag = n.node.parent?.getChild('OpenTag')?.getChild('TagName')
        const expected = parent_tag ? region_text.slice(parent_tag.from, parent_tag.to) : null
        const close_text = region_text.slice(n.from, n.to)
        const { from, to } = to_doc(n.from, n.to)
        if (from >= 0) {
          diagnostics.push({
            from,
            to: Math.max(to, from + 1),
            severity: 'error',
            message: expected
              ? `闭合标签 ${close_text} 与 <${expected}> 不匹配，应为 </${expected}>`
              : `多余的闭合标签 ${close_text}`,
            source: 'html',
          })
        }
      }
      else if (name === 'Element') {
        const open = n.node.getChild('OpenTag')
        const close = n.node.getChild('CloseTag')
        const last = n.node.lastChild
        if (open && open.getChild('EndTag') && ! close && last?.type.name !== 'MismatchedCloseTag') {
          const tag = open.getChild('TagName')
          const tag_name = tag ? region_text.slice(tag.from, tag.to) : '?'
          const { from, to } = to_doc(tag?.from ?? open.from, tag?.to ?? open.to)
          if (from >= 0) {
            diagnostics.push({
              from,
              to: Math.max(to, from + 1),
              severity: 'error',
              message: `缺少闭合标签 </${tag_name}>`,
              source: 'html',
            })
          }
        }
      }
    } })
  }

  return diagnostics
}

/** 1-based line number of an absolute document offset. */
export function html_lint_line(doc_text: string, from: number) {
  return doc_text.slice(0, from).split('\n').length
}
