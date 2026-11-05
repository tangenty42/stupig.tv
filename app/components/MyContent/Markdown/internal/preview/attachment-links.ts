/** Use the attachment projection before link options; DOM .href also expands relative routes. */
export function attachment_for_link<T>(attachments: ReadonlyMap<string, T>, link: Pick<HTMLAnchorElement, 'getAttribute'>) {
  return attachments.get(link.getAttribute('data-attachment-url') ?? link.getAttribute('href') ?? '')
}
