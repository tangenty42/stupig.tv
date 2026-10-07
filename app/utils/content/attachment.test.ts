import { describe, expect, it } from 'vitest'
import { attachment_download_url } from './attachment'

const static_url = (path: string) => `https://static.test${path}`

/** The value the static host echoes back as the response's Content-Disposition header. */
function disposition_of(url: string) {
  return new URL(url).searchParams.get('response-content-disposition')
}

const OBJECT_URL = '/content/att/uuid?version=e1'

describe('attachment_download_url', () => {
  it('names the download from the row name and keeps the version cache-bust', () => {
    const url = attachment_download_url(static_url, OBJECT_URL, 'docs/report.pdf')

    expect(new URL(url).searchParams.get('version')).toBe('e1')
    expect(disposition_of(url)).toBe(`attachment; filename*=UTF-8''report.pdf`)
  })

  it('drops the folder prefix and the .good encryption marker', () => {
    const url = attachment_download_url(static_url, OBJECT_URL, 'a/b/secret.png.good')

    expect(disposition_of(url)).toBe(`attachment; filename*=UTF-8''secret.png`)
  })

  it('percent-encodes a CJK name as an RFC 5987 ext-value', () => {
    const url = attachment_download_url(static_url, OBJECT_URL, '测试 文件.md')

    expect(disposition_of(url)).toBe(`attachment; filename*=UTF-8''%E6%B5%8B%E8%AF%95%20%E6%96%87%E4%BB%B6.md`)
  })

  // encodeURIComponent leaves these bare, but `'` delimits the ext-value and the
  // rest are not valid there either.
  it('escapes the characters encodeURIComponent leaves bare in an ext-value', () => {
    const url = attachment_download_url(static_url, OBJECT_URL, `it's (1)*!.txt`)

    expect(disposition_of(url)).toBe(`attachment; filename*=UTF-8''it%27s%20%281%29%2A%21.txt`)
  })

  it('starts the query string when the object URL carries none', () => {
    const url = attachment_download_url(static_url, '/content/att/uuid', 'report.pdf')

    expect(url.startsWith('https://static.test/content/att/uuid?response-content-disposition=')).toBe(true)
  })
})
