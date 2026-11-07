import { expect, it } from 'vitest'
import { attachment_for_link } from './attachment-links'

it.each(['/api/links/attachments/11?version=v1', 'https://static.test/objects/file.txt'])('matches a card to its attachment using the rendered href: %s', (url) => {
  const file = { file_name: 'file.txt' }
  // Native anchors expose an absolute .href even when the renderer supplied
  // a relative route. No DOM is needed to reproduce those two representations.
  const link = { href: new URL(url, 'https://site.test').href, getAttribute: (name: string) => name === 'href' ? url : null }
  expect(attachment_for_link(new Map([[url, file]]), link)).toBe(file)
  expect(attachment_for_link(new Map(), link)).toBeUndefined()
})
