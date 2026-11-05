/**
 * Triggers a browser save of `url`. For an http(s) URL the save name comes from
 * the response's Content-Disposition (see the signed download URL); `name` only
 * names blob: URLs, where no headers exist.
 */
export function save_url_as(url: string, name?: string) {
  const anchor = document.createElement('a')
  anchor.href = url
  if (name)
    anchor.download = name
  anchor.click()
}

export function open_url_in_new_tab(url: string) {
  window.open(url, '_blank', 'noopener,noreferrer')
}

export const content_browser_navigation = {
  open_url: open_url_in_new_tab,
  save_url: save_url_as,
}
