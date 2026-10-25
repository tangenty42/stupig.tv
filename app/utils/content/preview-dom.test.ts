import { expect, it, vi } from 'vitest'
import { create_preview_dom_patch } from './preview-dom'

// DOM boundary only: matching and patching run through the production utility.
// Parsing, real image loading, and hydration are verified in the browser.
class NodeBoundary {
  parentNode: NodeBoundary | null = null
  childNodes: NodeBoundary[] = []
  namespaceURI = 'http://www.w3.org/1999/xhtml'
  writes: string[] = []
  attrs = new Map<string, string>()
  constructor(readonly nodeName: string, readonly nodeType = 1, public nodeValue: string | null = null) {}
  get tagName() { return this.nodeName }
  get textContent(): string { return this.nodeValue ?? this.childNodes.map(child => child.textContent).join('') }
  get attributes() { return [... this.attrs].map(([name, value]) => ({ name, value, localName: name, namespaceURI: null })) }
  get classList() { return (this.attrs.get('class') ?? '').split(/\s+/).filter(Boolean) }
  get firstChild(): NodeBoundary | null { return this.childNodes[0] ?? null }
  get nextSibling(): NodeBoundary | null { return this.parentNode?.childNodes[this.parentNode.childNodes.indexOf(this) + 1] ?? null }
  getAttribute(name: string) { return this.attrs.get(name) ?? null }
  setAttribute(name: string, value: string) {
    this.writes.push(name)
    this.attrs.set(name, value)
  }

  setAttributeNS(_namespace: string | null, name: string, value: string) { this.setAttribute(name, value) }
  removeAttributeNS(_namespace: string | null, name: string) { this.attrs.delete(name) }
  insertBefore(node: NodeBoundary, reference: NodeBoundary | null) {
    node.parentNode?.removeChild(node)
    const index = reference ? this.childNodes.indexOf(reference) : this.childNodes.length
    if (index < 0)
      throw new Error('Reference is not a child')
    this.childNodes.splice(index, 0, node)
    node.parentNode = this
  }

  removeChild(node: NodeBoundary) {
    const index = this.childNodes.indexOf(node)
    if (index < 0)
      throw new Error('Node is not a child')
    this.childNodes.splice(index, 1)
    node.parentNode = null
  }

  querySelectorAll(selector: string): NodeBoundary[] {
    const tags = selector.toUpperCase().split(',')
    return this.childNodes.flatMap(child => [... (tags.includes(child.tagName) ? [child] : []), ... child.querySelectorAll(selector)])
  }
}

function element(tag: string, attrs: Record<string, string> = {}, ... children: (NodeBoundary | string)[]) {
  const node = new NodeBoundary(tag.toUpperCase())
  node.attrs = new Map(Object.entries(attrs))
  for (const child of children)
    node.insertBefore(typeof child === 'string' ? new NodeBoundary('#text', 3, child) : child, null)
  return node
}

function setup(... children: NodeBoundary[]) {
  const root = element('div', {}, ... children)
  const patch = create_preview_dom_patch(root as unknown as HTMLElement)
  return { root, update: (... next: NodeBoundary[]) => patch.update(element('#fragment', {}, ... next) as unknown as DocumentFragment) }
}

it('retains loaded media and runtime frame state while editing adjacent text and captions', () => {
  const image = element('img', { 'src': '/original.gif', 'data-preview-index': '0' })
  const frame = element('span', { class: 'img-frame' }, image)
  const caption = element('figcaption', {}, 'old')
  const figure = element('figure', {}, frame, caption)
  const { root, update } = setup(element('p', {}, 'before'), figure)
  frame.attrs.set('data-image-loaded', '')
  frame.attrs.set('data-cropped', '')
  frame.attrs.set('class', 'img-frame runtime-class')
  update(element('p', {}, 'edited'), element('figure', {},
    element('span', { class: 'img-frame updated' }, element('img', { 'src': '/original.gif', 'data-preview-index': '1' })),
    element('figcaption', {}, 'new')))
  expect(root.childNodes[1]).toBe(figure)
  expect(frame.childNodes[0]).toBe(image)
  expect(image.writes).toEqual(['data-preview-index'])
  expect(frame.getAttribute('data-image-loaded')).toBe('')
  expect(frame.getAttribute('data-cropped')).toBe('')
  expect(frame.classList).toEqual(['img-frame', 'updated', 'runtime-class'])
  expect(caption.textContent).toBe('new')
  expect(root.textContent).toBe('editednew')
})

it('does not consume an unchanged image block when text is inserted before it', () => {
  const image = element('img', { src: '/same.svg' })
  const paragraph = element('p', {}, image)
  const { root, update } = setup(paragraph)
  update(element('p', {}, 'new paragraph'), element('p', {}, element('img', { src: '/same.svg' })))
  expect(root.childNodes[1]).toBe(paragraph)
  expect(paragraph.firstChild).toBe(image)
  expect(image.writes).toEqual([])
})

it('keeps duplicate images distinct and carousel state intact through repeated edits', () => {
  const a = element('img', { src: '/same.png' })
  const b = element('img', { src: '/same.png' })
  const carousel = element('div', { class: 'image-carousel' }, a, b)
  const scroll = { left: 240 }
  Object.assign(carousel, { scroll })
  const { root, update } = setup(element('p', {}, 'text'), carousel)
  for (const text of ['a', 'ab', 'abc'])
    update(element('p', {}, text), element('div', { class: 'image-carousel' }, element('img', { src: '/same.png' }), element('img', { src: '/same.png' })))
  expect(root.childNodes[1]).toBe(carousel)
  expect(carousel.childNodes[0]).toBe(a)
  expect(carousel.childNodes[1]).toBe(b)
  expect(Object.getOwnPropertyDescriptor(carousel, 'scroll')?.value).toBe(scroll)
  expect(scroll.left).toBe(240)
  expect(a.writes).toEqual([])
  expect(b.writes).toEqual([])
})

it('replaces changed representations and removes media that is no longer readable', () => {
  const image = element('img', { src: '/private.avif', srcset: '/private.jpg 1x' })
  const { root, update } = setup(element('p', {}, image))
  const redacted = element('img', { src: '/redacted.avif', srcset: '/redacted.jpg 1x' })
  update(element('p', {}, redacted))
  expect(image.parentNode).toBeNull()
  expect(root.childNodes[0]?.firstChild).toBe(redacted)
  update(element('aside', { class: 'invalid-reference' }, 'not available'))
  expect(root.querySelectorAll('img')).toEqual([])
  expect(redacted.parentNode?.parentNode).toBeNull()
  expect(root.textContent).toBe('not available')
})

it('updates ordinary links, attributes, and deleted blocks without leaving stale source content', () => {
  const link = element('a', { href: '/old', title: 'old' }, 'old')
  const root = element('div', {}, link, element('p', {}, 'removed'))
  const patch = create_preview_dom_patch(root as unknown as HTMLElement)
  const insert = vi.spyOn(root, 'insertBefore')
  patch.update(element('#fragment', {}, element('a', { href: '/new' }, 'new')) as unknown as DocumentFragment)
  expect(root.childNodes).toHaveLength(1)
  expect(root.firstChild).toBe(link)
  expect(link.getAttribute('href')).toBe('/new')
  expect(link.getAttribute('title')).toBeNull()
  expect(link.textContent).toBe('new')
  expect(insert).not.toHaveBeenCalled()
})
