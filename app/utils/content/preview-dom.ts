interface PreviewAttribute {
  name: string
  local: string
  namespace: string | null
  value: string
}

interface PreviewNode {
  node: ChildNode
  key: string
  attributes: PreviewAttribute[]
  value: string | null
  children: PreviewNode[]
}

const media_tags = new Set(['IMG', 'VIDEO', 'AUDIO', 'IFRAME', 'SOURCE'])

function media_key(element: Element) {
  return [element.tagName, ... ['src', 'srcset', 'sizes', 'poster', 'type'].map(name => element.getAttribute(name) ?? '')].join('|')
}

function snapshot(node: ChildNode): PreviewNode {
  const element = node.nodeType === 1 ? node as Element : null
  const media = element
    ? [
        ... (media_tags.has(element.tagName) ? [media_key(element)] : []),
        ... Array.from(element.querySelectorAll('img,video,audio,iframe,source'), media_key),
      ]
    : []
  return {
    node,
    key: JSON.stringify([node.nodeType, node.nodeName, element?.getAttribute('id'), media.length ? media : node.textContent]),
    attributes: element ? Array.from(element.attributes, attr => ({ name: attr.name, local: attr.localName, namespace: attr.namespaceURI, value: attr.value })) : [],
    value: node.nodeValue,
    children: Array.from(node.childNodes, snapshot),
  }
}

function compatible(before: PreviewNode, after: PreviewNode) {
  if (before.node.nodeType !== after.node.nodeType || before.node.nodeName !== after.node.nodeName
    || (before.node.nodeType === 1 && (before.node as Element).namespaceURI !== (after.node as Element).namespaceURI)) {
    return false
  }
  // A new representation gets a fresh media node, including a fresh loader.
  return ! media_tags.has(after.node.nodeName) || before.key === after.key
}

function patch_attributes(before: PreviewNode, after: PreviewNode) {
  const element = before.node as Element
  const previous = new Map(before.attributes.map(attr => [attr.name, attr]))
  const next = new Map(after.attributes.map(attr => [attr.name, attr]))
  for (const attr of before.attributes) {
    if (! next.has(attr.name))
      element.removeAttributeNS(attr.namespace, attr.local)
  }
  for (const attr of after.attributes) {
    // Compare renderer-owned snapshots, not enhanced live DOM. This retains
    // loading/crop/nav state and avoids reassigning an unchanged image src.
    if (previous.get(attr.name)?.value === attr.value)
      continue
    if (attr.name === 'class') {
      const owned = new Set((previous.get('class')?.value ?? '').split(/\s+/))
      const runtime = Array.from(element.classList).filter(name => ! owned.has(name))
      element.setAttribute('class', [... new Set([... attr.value.split(/\s+/), ... runtime])].filter(Boolean).join(' '))
    }
    else {
      element.setAttributeNS(attr.namespace, attr.name, attr.value)
    }
  }
}

/** Patch only renderer-owned content; preserve unchanged live media identities. */
export function create_preview_dom_patch(root: HTMLElement) {
  let current = Array.from(root.childNodes, snapshot)

  function children(parent: Node, before: PreviewNode[], after: PreviewNode[]): PreviewNode[] {
    const unused = new Set(before)
    const future = new Map<string, number>()
    for (const child of after)
      future.set(child.key, (future.get(child.key) ?? 0) + 1)
    // Heading compensation and other enhancements may append their own nodes.
    const owned = new Set(before.map(child => child.node))
    for (const child of Array.from(parent.childNodes)) {
      if (! owned.has(child))
        parent.removeChild(child)
    }
    let cursor = parent.firstChild
    const result = after.map((next) => {
      future.set(next.key, future.get(next.key)! - 1)
      const exact = before.find(child => unused.has(child) && child.key === next.key && compatible(child, next))
      // Do not consume a node that a later unchanged block still needs. This
      // keeps an image in place when text is inserted immediately before it.
      const previous = exact ?? before.find(child => unused.has(child) && ! future.get(child.key) && compatible(child, next))
      let updated = next
      if (previous) {
        unused.delete(previous)
        if (previous.node.nodeType === 1)
          patch_attributes(previous, next)
        else if (previous.value !== next.value)
          previous.node.nodeValue = next.value
        updated = { ... next, node: previous.node, children: children(previous.node, previous.children, next.children) }
      }
      if (updated.node !== cursor)
        parent.insertBefore(updated.node, cursor)
      cursor = updated.node.nextSibling
      return updated
    })
    for (const child of unused)
      parent.removeChild(child.node)
    return result
  }

  return {
    update(next: DocumentFragment) {
      current = children(root, current, Array.from(next.childNodes, snapshot))
    },
  }
}

/** Parse in an inert template: discarded matching images never start requests. */
export function preview_html_fragment(html: string, owner: Document) {
  const template = owner.createElement('template')
  template.innerHTML = html
  // innerHTML's scripts never execute. Preserve that behavior when new nodes
  // move out of the inert template and into the document.
  for (const script of template.content.querySelectorAll('script')) {
    const inert = owner.createElement('div')
    inert.innerHTML = script.outerHTML
    script.replaceWith(inert.firstChild!)
  }
  return template.content
}
